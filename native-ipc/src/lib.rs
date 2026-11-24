use crossbeam_channel::{bounded, Sender, TrySendError};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(unix)]
use std::os::unix::io::AsRawFd;

#[cfg(windows)]
type UnixListener = std::net::TcpListener;
#[cfg(windows)]
type UnixStream = std::net::TcpStream;

const SEND_CHANNEL_CAP: usize = 128;
const MAX_QUEUED_BYTES: u64 = 128 * 1024 * 1024;
const PER_CLIENT_BUF_CAP: usize = 64 * 1024 * 1024;
const WRITER_THREADS: usize = 2;
const MAX_BATCH_AGE: Duration = Duration::from_secs(30);
const CLIENT_STALL_TIMEOUT: Duration = Duration::from_secs(30);

struct ClientState {
    stream: UnixStream,
    id: u32,
    write_buf: VecDeque<u8>,
    stalled_since: Option<Instant>,
}

impl ClientState {
    fn new(stream: UnixStream, id: u32) -> Self {
        Self { stream, id, write_buf: VecDeque::new(), stalled_since: None }
    }

    fn queue(&mut self, data: &[u8]) -> bool {
        if self.write_buf.len() + data.len() > PER_CLIENT_BUF_CAP {
            return false;
        }
        self.write_buf.extend(data);
        true
    }

    fn flush_buf(&mut self) -> io::Result<usize> {
        let mut total = 0;
        while !self.write_buf.is_empty() {
            let (front, back) = self.write_buf.as_slices();
            let chunk = if !front.is_empty() { front } else { back };
            match self.stream.write(chunk) {
                Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "write returned 0")),
                Ok(n) => {
                    self.write_buf.drain(..n);
                    total += n;
                    self.stalled_since = None;
                }
                Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {
                    if self.stalled_since.is_none() {
                        self.stalled_since = Some(Instant::now());
                    }
                    break;
                }
                Err(e) => return Err(e),
            }
        }
        Ok(total)
    }
}

struct ServerInner {
    socket_path: String,
    delimiter: Vec<u8>,
    running: AtomicBool,
    client_count: AtomicU32,
    next_client_id: AtomicU32,
    queued_bytes: AtomicU64,
    bytes_written: AtomicU64,
    msgs_written: AtomicU64,
    write_tx: Mutex<Option<Sender<WriteMsg>>>,
    clients: Mutex<Vec<ClientState>>,
    last_backpressure_log: Mutex<Instant>,
    last_stats_log: Mutex<Instant>,
    evicted_batches: AtomicU64,
    evicted_bytes: AtomicU64,
    stall_disconnects: AtomicU64,
}

enum WriteMsg {
    Data(Vec<u8>, Instant),
    Batch(Vec<u8>, Instant),
    Stop,
}

#[napi]
pub struct NativeIpcServer {
    inner: Arc<ServerInner>,
}

#[cfg(unix)]
fn set_nonblocking(stream: &UnixStream) {
    use std::os::unix::io::AsRawFd;
    let fd = stream.as_raw_fd();
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
}

#[cfg(unix)]
fn enlarge_send_buffer(stream: &UnixStream, size: i32) {
    let fd = stream.as_raw_fd();
    unsafe {
        libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_SNDBUF,
            &size as *const i32 as *const libc::c_void,
            std::mem::size_of::<i32>() as libc::socklen_t,
        );
    }
}

#[cfg(windows)]
fn set_nonblocking(stream: &UnixStream) {
    stream.set_nonblocking(true).ok();
}

#[cfg(windows)]
fn enlarge_send_buffer(_stream: &UnixStream, _size: i32) {}

#[napi]
impl NativeIpcServer {
    #[napi(constructor)]
    pub fn new(socket_path: String, delimiter: String) -> Self {
        Self {
            inner: Arc::new(ServerInner {
                socket_path,
                delimiter: delimiter.into_bytes(),
                running: AtomicBool::new(false),
                client_count: AtomicU32::new(0),
                next_client_id: AtomicU32::new(1),
                queued_bytes: AtomicU64::new(0),
                bytes_written: AtomicU64::new(0),
                msgs_written: AtomicU64::new(0),
                write_tx: Mutex::new(None),
                clients: Mutex::new(Vec::new()),
                last_backpressure_log: Mutex::new(Instant::now()),
                last_stats_log: Mutex::new(Instant::now()),
                evicted_batches: AtomicU64::new(0),
                evicted_bytes: AtomicU64::new(0),
                stall_disconnects: AtomicU64::new(0),
            }),
        }
    }

    #[napi]
    pub fn start(&self) -> Result<()> {
        if self.inner.running.load(Ordering::Relaxed) {
            return Ok(());
        }

        let (write_tx, write_rx) = bounded::<WriteMsg>(SEND_CHANNEL_CAP);
        *self.inner.write_tx.lock().unwrap() = Some(write_tx);

        self.inner.running.store(true, Ordering::Relaxed);

        // Acceptor thread
        let inner = self.inner.clone();
        std::thread::Builder::new()
            .name("ipc-acceptor".into())
            .spawn(move || {
                let listener = match create_listener(&inner.socket_path) {
                    Ok(l) => l,
                    Err(e) => {
                        eprintln!("[native-ipc] Failed to bind {}: {e}", inner.socket_path);
                        return;
                    }
                };
                listener.set_nonblocking(true).ok();

                while inner.running.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((mut stream, _addr)) => {
                            let id = inner.next_client_id.fetch_add(1, Ordering::Relaxed);

                            let ack = b"{\"ok\":true}\n";
                            if let Err(e) = stream.write_all(ack) {
                                eprintln!("[native-ipc] Client {id} ACK write failed: {e}");
                                stream.shutdown(Shutdown::Both).ok();
                                continue;
                            }

                            stream.set_read_timeout(Some(Duration::from_millis(200))).ok();
                            let mut sub_buf = [0u8; 512];
                            let _ = stream.read(&mut sub_buf);
                            stream.set_read_timeout(None).ok();

                            set_nonblocking(&stream);
                            enlarge_send_buffer(&stream, 4 * 1024 * 1024);
                            let client = ClientState::new(stream, id);
                            inner.clients.lock().unwrap().push(client);
                            inner.client_count.fetch_add(1, Ordering::Relaxed);
                            eprintln!("[native-ipc] Client {id} connected (total: {})",
                                inner.client_count.load(Ordering::Relaxed));
                        }
                        Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(50));
                        }
                        Err(e) => {
                            if inner.running.load(Ordering::Relaxed) {
                                eprintln!("[native-ipc] Accept error: {e}");
                            }
                            break;
                        }
                    }
                }

                drop(listener);
                #[cfg(unix)]
                std::fs::remove_file(&inner.socket_path).ok();
            })
            .map_err(|e| Error::from_reason(format!("spawn acceptor: {e}")))?;

        // Writer threads
        for t in 0..WRITER_THREADS {
            let rx = write_rx.clone();
            let inner = self.inner.clone();
            std::thread::Builder::new()
                .name(format!("ipc-writer-{t}"))
                .spawn(move || {
                    writer_loop(rx, inner);
                })
                .map_err(|e| Error::from_reason(format!("spawn writer: {e}")))?;
        }
        drop(write_rx);

        Ok(())
    }

    #[napi]
    pub fn send(&self, data: String) -> bool {
        let tx_guard = self.inner.write_tx.lock().unwrap();
        let tx = match tx_guard.as_ref() {
            Some(tx) => tx,
            None => return false,
        };

        let queued = self.inner.queued_bytes.load(Ordering::Relaxed);
        if queued > MAX_QUEUED_BYTES {
            let mut last = self.inner.last_backpressure_log.lock().unwrap();
            if last.elapsed() >= Duration::from_secs(10) {
                eprintln!(
                    "[native-ipc] Backpressure: {:.1}MB queued (cap {:.0}MB), skipping",
                    queued as f64 / 1_048_576.0,
                    MAX_QUEUED_BYTES as f64 / 1_048_576.0,
                );
                *last = Instant::now();
            }
            return false;
        }

        let mut frame = data.into_bytes();
        frame.extend_from_slice(&self.inner.delimiter);
        let frame_len = frame.len() as u64;

        match tx.try_send(WriteMsg::Data(frame, Instant::now())) {
            Ok(()) => {
                self.inner.queued_bytes.fetch_add(frame_len, Ordering::Relaxed);
                true
            }
            Err(TrySendError::Full(_)) => false,
            Err(TrySendError::Disconnected(_)) => false,
        }
    }

    #[napi]
    pub fn send_batch(&self, data: Buffer) -> bool {
        let tx_guard = self.inner.write_tx.lock().unwrap();
        let tx = match tx_guard.as_ref() {
            Some(tx) => tx,
            None => return false,
        };

        let queued = self.inner.queued_bytes.load(Ordering::Relaxed);
        if queued > MAX_QUEUED_BYTES {
            let mut last = self.inner.last_backpressure_log.lock().unwrap();
            if last.elapsed() >= Duration::from_secs(10) {
                eprintln!(
                    "[native-ipc] Backpressure: {:.1}MB queued (cap {:.0}MB), skipping batch",
                    queued as f64 / 1_048_576.0,
                    MAX_QUEUED_BYTES as f64 / 1_048_576.0,
                );
                *last = Instant::now();
            }
            return false;
        }

        let bytes = data.to_vec();
        let len = bytes.len() as u64;

        match tx.try_send(WriteMsg::Batch(bytes, Instant::now())) {
            Ok(()) => {
                self.inner.queued_bytes.fetch_add(len, Ordering::Relaxed);
                true
            }
            Err(TrySendError::Full(_)) => false,
            Err(TrySendError::Disconnected(_)) => false,
        }
    }

    #[napi]
    pub fn get_client_count(&self) -> u32 {
        self.inner.client_count.load(Ordering::Relaxed)
    }

    #[napi]
    pub fn is_running(&self) -> bool {
        self.inner.running.load(Ordering::Relaxed)
    }

    #[napi]
    pub fn get_stats(&self) -> String {
        let queued = self.inner.queued_bytes.load(Ordering::Relaxed);
        let written = self.inner.bytes_written.load(Ordering::Relaxed);
        let msgs = self.inner.msgs_written.load(Ordering::Relaxed);
        let evicted = self.inner.evicted_batches.load(Ordering::Relaxed);
        let evicted_mb = self.inner.evicted_bytes.load(Ordering::Relaxed) as f64 / 1_048_576.0;
        let stalls = self.inner.stall_disconnects.load(Ordering::Relaxed);
        let clients = self.inner.clients.lock().unwrap();
        let buf_total: usize = clients.iter().map(|c| c.write_buf.len()).sum();
        let stalled_count = clients.iter().filter(|c| c.stalled_since.is_some()).count();
        format!(
            "queued={:.1}MB written={:.1}MB msgs={} client_bufs={:.1}MB evicted={} evicted_mb={:.1} stall_disconnects={} stalled_clients={}",
            queued as f64 / 1_048_576.0,
            written as f64 / 1_048_576.0,
            msgs,
            buf_total as f64 / 1_048_576.0,
            evicted,
            evicted_mb,
            stalls,
            stalled_count,
        )
    }

    #[napi]
    pub fn get_queued_bytes(&self) -> f64 {
        self.inner.queued_bytes.load(Ordering::Relaxed) as f64
    }

    #[napi]
    pub fn get_eviction_stats(&self) -> String {
        let batches = self.inner.evicted_batches.load(Ordering::Relaxed);
        let bytes = self.inner.evicted_bytes.load(Ordering::Relaxed);
        let stalls = self.inner.stall_disconnects.load(Ordering::Relaxed);
        format!(
            "evicted_batches={} evicted_bytes={:.1}MB stall_disconnects={}",
            batches,
            bytes as f64 / 1_048_576.0,
            stalls,
        )
    }

    #[napi]
    pub fn stop(&self) -> Result<()> {
        self.inner.running.store(false, Ordering::Relaxed);

        if let Some(tx) = self.inner.write_tx.lock().unwrap().take() {
            let _ = tx.send(WriteMsg::Stop);
        }

        let mut clients = self.inner.clients.lock().unwrap();
        for client in clients.drain(..) {
            client.stream.shutdown(Shutdown::Both).ok();
        }
        self.inner.client_count.store(0, Ordering::Relaxed);

        #[cfg(unix)]
        std::fs::remove_file(&self.inner.socket_path).ok();

        Ok(())
    }
}

fn broadcast_frame(inner: &ServerInner, data: &[u8]) {
    let mut clients = inner.clients.lock().unwrap();
    let mut disconnected = Vec::new();

    for client in clients.iter_mut() {
        if !client.queue(data) {
            eprintln!(
                "[native-ipc] Client {} buffer full ({:.1}MB), disconnecting",
                client.id,
                client.write_buf.len() as f64 / 1_048_576.0,
            );
            client.stream.shutdown(Shutdown::Both).ok();
            disconnected.push(client.id);
            continue;
        }

        match client.flush_buf() {
            Ok(n) => {
                if n > 0 {
                    inner.bytes_written.fetch_add(n as u64, Ordering::Relaxed);
                }
            }
            Err(_) => {
                eprintln!("[native-ipc] Client {} disconnected (write error)", client.id);
                client.stream.shutdown(Shutdown::Both).ok();
                disconnected.push(client.id);
            }
        }
    }

    if !disconnected.is_empty() {
        clients.retain(|c| !disconnected.contains(&c.id));
        inner.client_count.store(clients.len() as u32, Ordering::Relaxed);
    }

    inner.msgs_written.fetch_add(1, Ordering::Relaxed);
}

fn flush_pending_buffers(inner: &ServerInner) {
    let mut clients = inner.clients.lock().unwrap();
    let mut disconnected = Vec::new();

    for client in clients.iter_mut() {
        if let Some(stalled_at) = client.stalled_since {
            let stall_duration = stalled_at.elapsed();
            if stall_duration > CLIENT_STALL_TIMEOUT {
                eprintln!(
                    "[native-ipc] Client {} stalled for {:.1}s (limit {}s, buf={:.1}MB), disconnecting",
                    client.id,
                    stall_duration.as_secs_f64(),
                    CLIENT_STALL_TIMEOUT.as_secs(),
                    client.write_buf.len() as f64 / 1_048_576.0,
                );
                inner.stall_disconnects.fetch_add(1, Ordering::Relaxed);
                client.stream.shutdown(Shutdown::Both).ok();
                disconnected.push(client.id);
                continue;
            }
        }
        if client.write_buf.is_empty() {
            continue;
        }
        match client.flush_buf() {
            Ok(n) => {
                if n > 0 {
                    inner.bytes_written.fetch_add(n as u64, Ordering::Relaxed);
                }
            }
            Err(_) => {
                eprintln!("[native-ipc] Client {} disconnected (flush error)", client.id);
                client.stream.shutdown(Shutdown::Both).ok();
                disconnected.push(client.id);
            }
        }
    }

    if !disconnected.is_empty() {
        clients.retain(|c| !disconnected.contains(&c.id));
        inner.client_count.store(clients.len() as u32, Ordering::Relaxed);
    }
}

fn writer_loop(rx: crossbeam_channel::Receiver<WriteMsg>, inner: Arc<ServerInner>) {
    loop {
        match rx.recv_timeout(Duration::from_millis(5)) {
            Ok(WriteMsg::Data(data, created_at)) => {
                let data_len = data.len() as u64;
                inner.queued_bytes.fetch_sub(data_len, Ordering::Relaxed);
                let age = created_at.elapsed();
                if age > MAX_BATCH_AGE {
                    inner.evicted_batches.fetch_add(1, Ordering::Relaxed);
                    inner.evicted_bytes.fetch_add(data_len, Ordering::Relaxed);
                    eprintln!(
                        "[native-ipc] Evicting stale data frame ({:.1}s old, limit {}s, {:.1}KB)",
                        age.as_secs_f64(),
                        MAX_BATCH_AGE.as_secs(),
                        data_len as f64 / 1024.0,
                    );
                    continue;
                }
                broadcast_frame(&inner, &data);
            }
            Ok(WriteMsg::Batch(raw, created_at)) => {
                let raw_len = raw.len() as u64;
                inner.queued_bytes.fetch_sub(raw_len, Ordering::Relaxed);
                let age = created_at.elapsed();
                if age > MAX_BATCH_AGE {
                    inner.evicted_batches.fetch_add(1, Ordering::Relaxed);
                    inner.evicted_bytes.fetch_add(raw_len, Ordering::Relaxed);
                    eprintln!(
                        "[native-ipc] Evicting stale batch ({:.1}s old, limit {}s, {:.1}KB)",
                        age.as_secs_f64(),
                        MAX_BATCH_AGE.as_secs(),
                        raw_len as f64 / 1024.0,
                    );
                    continue;
                }
                match decode_batch_to_json(&raw) {
                    Some(mut json) => {
                        json.extend_from_slice(&inner.delimiter);
                        broadcast_frame(&inner, &json);
                    }
                    None => {
                        eprintln!("[native-ipc] Failed to decode batch ({raw_len} bytes)");
                    }
                }
            }
            Ok(WriteMsg::Stop) => break,
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                flush_pending_buffers(&inner);
            }
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
        }

        let mut last = inner.last_stats_log.lock().unwrap();
        if last.elapsed() >= Duration::from_secs(30) {
            let written = inner.bytes_written.load(Ordering::Relaxed);
            let msgs = inner.msgs_written.load(Ordering::Relaxed);
            let evicted = inner.evicted_batches.load(Ordering::Relaxed);
            let evicted_mb = inner.evicted_bytes.load(Ordering::Relaxed) as f64 / 1_048_576.0;
            let stalls = inner.stall_disconnects.load(Ordering::Relaxed);
            let clients = inner.clients.lock().unwrap();
            let buf_total: usize = clients.iter().map(|c| c.write_buf.len()).sum();
            let stalled_count = clients.iter().filter(|c| c.stalled_since.is_some()).count();
            eprintln!(
                "[native-ipc] stats: written={:.1}MB msgs={} clients={} pending_bufs={:.1}MB evicted={} evicted_mb={:.1} stall_disconnects={} stalled_clients={}",
                written as f64 / 1_048_576.0,
                msgs,
                clients.len(),
                buf_total as f64 / 1_048_576.0,
                evicted,
                evicted_mb,
                stalls,
                stalled_count,
            );
            *last = Instant::now();
        }
    }
}

#[cfg(unix)]
fn create_listener(path: &str) -> io::Result<UnixListener> {
    std::fs::remove_file(path).ok();
    UnixListener::bind(path)
}

#[cfg(windows)]
fn create_listener(path: &str) -> io::Result<UnixListener> {
    let addr = if path.contains(':') {
        path.to_string()
    } else {
        let hash: u16 = path.bytes().fold(0u16, |acc, b| acc.wrapping_add(b as u16));
        let port = 10000 + (hash % 50000);
        format!("127.0.0.1:{port}")
    };
    eprintln!("[native-ipc] Windows mode: listening on TCP {addr}");
    UnixListener::bind(&addr)
}

// ---- Binary batch decoding → JSON serialization ----
//
// Format v1 (written by RustSocketServer.encodeBatch in TypeScript):
//
//   [1 byte]  version = 1
//   [4 bytes] u32 LE point count
//   [str]     batch timestamp (ISO 8601)
//
//   Per point:
//     [4 bytes] u32 LE bitmask (which optional fields are present)
//     [str]     timestamp
//     [str]     deviceName
//     if bit 0:  [str] deviceId
//     if bit 1:  [str] endpoint_uuid
//     if bit 2:  [str] device_uuid
//     if bit 3:  [str] protocol
//     if bit 4:  [str] resolvedDisplayName
//     if bit 5:  [str] deviceDisplayName
//     [str]     metric
//     [1 byte]  value type: 0=null 1=f64 2=true 3=false 4=string
//       if 1: [8 bytes] f64 LE
//       if 4: [str]
//     if bit 14: [str] unit
//     [1 byte]  quality: 0=GOOD 1=BAD 2=UNCERTAIN
//     if bit 6:  [str] qualityCode
//     if bit 7:  [str] rawObjectName
//     if bit 8:  [str] rawPointName
//     if bit 9:  [str] normalizationName
//     if bit 10: [str] normalizationDeviceName
//     if bit 11: [str] sourceEndpointName
//     if bit 12: [str] pointUuid
//     bit 13: writable flag (no data bytes)
//
//   [str] = [2 bytes u16 LE length] [utf-8 bytes]

struct BufReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> BufReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    fn read_u8(&mut self) -> Option<u8> {
        if self.remaining() < 1 { return None; }
        let v = self.data[self.pos];
        self.pos += 1;
        Some(v)
    }

    fn read_u16(&mut self) -> Option<u16> {
        if self.remaining() < 2 { return None; }
        let v = u16::from_le_bytes([self.data[self.pos], self.data[self.pos + 1]]);
        self.pos += 2;
        Some(v)
    }

    fn read_u32(&mut self) -> Option<u32> {
        if self.remaining() < 4 { return None; }
        let v = u32::from_le_bytes([
            self.data[self.pos], self.data[self.pos + 1],
            self.data[self.pos + 2], self.data[self.pos + 3],
        ]);
        self.pos += 4;
        Some(v)
    }

    fn read_f64(&mut self) -> Option<f64> {
        if self.remaining() < 8 { return None; }
        let v = f64::from_le_bytes([
            self.data[self.pos], self.data[self.pos + 1],
            self.data[self.pos + 2], self.data[self.pos + 3],
            self.data[self.pos + 4], self.data[self.pos + 5],
            self.data[self.pos + 6], self.data[self.pos + 7],
        ]);
        self.pos += 8;
        Some(v)
    }

    fn read_str(&mut self) -> Option<&'a [u8]> {
        let len = self.read_u16()? as usize;
        if self.remaining() < len { return None; }
        let s = &self.data[self.pos..self.pos + len];
        self.pos += len;
        Some(s)
    }
}

const HEX: [u8; 16] = *b"0123456789abcdef";

fn write_json_escaped(out: &mut Vec<u8>, s: &[u8]) {
    for &b in s {
        match b {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\r' => out.extend_from_slice(b"\\r"),
            b'\t' => out.extend_from_slice(b"\\t"),
            b if b < 0x20 => {
                out.extend_from_slice(b"\\u00");
                out.push(HEX[(b >> 4) as usize]);
                out.push(HEX[(b & 0x0f) as usize]);
            }
            _ => out.push(b),
        }
    }
}

fn write_json_number(out: &mut Vec<u8>, v: f64) {
    if v.is_nan() || v.is_infinite() {
        out.extend_from_slice(b"null");
    } else {
        write!(out, "{}", v).unwrap();
    }
}

fn write_json_key_str(out: &mut Vec<u8>, key: &[u8], val: &[u8]) {
    out.extend_from_slice(b",\"");
    out.extend_from_slice(key);
    out.extend_from_slice(b"\":\"");
    write_json_escaped(out, val);
    out.push(b'"');
}

fn write_opt_field(
    reader: &mut BufReader,
    out: &mut Vec<u8>,
    mask: u32,
    bit: u32,
    name: &[u8],
) -> Option<()> {
    if mask & (1 << bit) != 0 {
        let val = reader.read_str()?;
        write_json_key_str(out, name, val);
    }
    Some(())
}

const OPT_NAMES_A: [&[u8]; 6] = [
    b"deviceId",
    b"endpoint_uuid",
    b"device_uuid",
    b"protocol",
    b"resolvedDisplayName",
    b"deviceDisplayName",
];

const OPT_NAMES_B: [&[u8]; 7] = [
    b"qualityCode",
    b"rawObjectName",
    b"rawPointName",
    b"normalizationName",
    b"normalizationDeviceName",
    b"sourceEndpointName",
    b"pointUuid",
];

fn write_reading_json(reader: &mut BufReader, out: &mut Vec<u8>) -> Option<()> {
    let mask = reader.read_u32()?;

    out.push(b'{');

    let ts = reader.read_str()?;
    out.extend_from_slice(b"\"timestamp\":\"");
    write_json_escaped(out, ts);
    out.push(b'"');

    let dn = reader.read_str()?;
    write_json_key_str(out, b"deviceName", dn);

    for (i, name) in OPT_NAMES_A.iter().enumerate() {
        write_opt_field(reader, out, mask, i as u32, name)?;
    }

    let metric = reader.read_str()?;
    write_json_key_str(out, b"metric", metric);

    out.extend_from_slice(b",\"value\":");
    let vtype = reader.read_u8()?;
    match vtype {
        0 => out.extend_from_slice(b"null"),
        1 => {
            let v = reader.read_f64()?;
            write_json_number(out, v);
        }
        2 => out.extend_from_slice(b"true"),
        3 => out.extend_from_slice(b"false"),
        4 => {
            let s = reader.read_str()?;
            out.push(b'"');
            write_json_escaped(out, s);
            out.push(b'"');
        }
        _ => out.extend_from_slice(b"null"),
    }

    if mask & (1 << 14) != 0 {
        let unit = reader.read_str()?;
        write_json_key_str(out, b"unit", unit);
    }

    let q = reader.read_u8()?;
    out.extend_from_slice(b",\"quality\":\"");
    out.extend_from_slice(match q {
        0 => b"GOOD" as &[u8],
        1 => b"BAD",
        _ => b"UNCERTAIN",
    });
    out.push(b'"');

    for (i, name) in OPT_NAMES_B.iter().enumerate() {
        write_opt_field(reader, out, mask, (i + 6) as u32, name)?;
    }

    if mask & (1 << 13) != 0 {
        out.extend_from_slice(b",\"writable\":true");
    }

    out.push(b'}');
    Some(())
}

fn decode_batch_to_json(buf: &[u8]) -> Option<Vec<u8>> {
    let mut reader = BufReader::new(buf);

    let version = reader.read_u8()?;
    if version != 1 {
        eprintln!("[native-ipc] Unknown batch format version: {version}");
        return None;
    }

    let count = reader.read_u32()?;
    if count as usize > reader.remaining() {
        eprintln!("[native-ipc] Batch count ({count}) exceeds remaining buffer ({} bytes), rejecting", reader.remaining());
        return None;
    }
    let batch_ts = reader.read_str()?;

    let mut out = Vec::with_capacity(count as usize * 400 + 128);

    if count == 1 {
        write_reading_json(&mut reader, &mut out)?;
    } else {
        out.extend_from_slice(b"{\"timestamp\":\"");
        write_json_escaped(&mut out, batch_ts);
        out.extend_from_slice(b"\",\"readings\":[");
        for i in 0..count {
            if i > 0 {
                out.push(b',');
            }
            write_reading_json(&mut reader, &mut out)?;
        }
        out.extend_from_slice(b"]}");
    }

    Some(out)
}
