use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
    ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi_derive::napi;

use opcua::client::prelude::*;
use opcua::sync::RwLock;
use tokio::sync::oneshot;

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

// ---- Thread naming helper (Unix only) ----

#[cfg(unix)]
fn set_thread_name(name: &str) {
    use libc::{prctl, PR_SET_NAME};
    let name_cstr = std::ffi::CString::new(&name[..15.min(name.len())])
        .unwrap_or_default();
    unsafe {
        let _ = prctl(PR_SET_NAME, name_cstr.as_ptr() as u64, 0, 0, 0);
    }
}

#[cfg(not(unix))]
fn set_thread_name(_name: &str) {
    // Windows/other platforms: no-op
}

// ---- NAPI config objects (passed from Node.js at subscribe time) ----

#[napi(object)]
#[derive(Clone)]
pub struct SubscriberConfig {
    pub endpoint_url: String,
    pub security_mode: Option<String>,
    pub security_policy: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub application_name: Option<String>,
    pub session_timeout_ms: Option<u32>,
    pub certificate_trust_mode: Option<String>,
}

#[napi(object)]
#[derive(Clone)]
pub struct NodeConfig {
    pub node_id: String,
    pub device_name: String,
    pub metric: String,
    pub device_id: Option<String>,
    pub endpoint_uuid: Option<String>,
    pub device_uuid: Option<String>,
    pub protocol: Option<String>,
    pub resolved_display_name: Option<String>,
    pub device_display_name: Option<String>,
    pub source_endpoint_name: Option<String>,
    pub point_uuid: Option<String>,
    pub unit: Option<String>,
    pub writable: Option<bool>,
    pub raw_object_name: Option<String>,
    pub raw_point_name: Option<String>,
    pub normalization_name: Option<String>,
    pub normalization_device_name: Option<String>,
}

// ---- Stats ----

struct Stats {
    connected: AtomicBool,
    subscribed_nodes: AtomicU64,
    data_changes: AtomicU64,
    batches_sent: AtomicU64,
    bytes_encoded: AtomicU64,
    callback_errors: AtomicU64,
    encode_errors: AtomicU64,
    last_data_change_at: parking_lot::Mutex<Option<Instant>>,
    started_at: parking_lot::Mutex<Option<Instant>>,
    reconnect_count: AtomicU64,
    reconnect_failures: AtomicU64,
}

impl Stats {
    fn new() -> Self {
        Self {
            connected: AtomicBool::new(false),
            subscribed_nodes: AtomicU64::new(0),
            data_changes: AtomicU64::new(0),
            batches_sent: AtomicU64::new(0),
            bytes_encoded: AtomicU64::new(0),
            callback_errors: AtomicU64::new(0),
            encode_errors: AtomicU64::new(0),
            last_data_change_at: parking_lot::Mutex::new(None),
            started_at: parking_lot::Mutex::new(None),
            reconnect_count: AtomicU64::new(0),
            reconnect_failures: AtomicU64::new(0),
        }
    }
}

// ---- Binary batch encoder (same wire format as ipc) ----

fn write_str(buf: &mut Vec<u8>, s: &str) {
    let bytes = s.as_bytes();
    let len = bytes.len() as u16;
    buf.extend_from_slice(&len.to_le_bytes());
    buf.extend_from_slice(bytes);
}

fn encode_batch(
    timestamp: &str,
    changes: &[(usize, DataValue)],
    nodes: &[NodeConfig],
) -> Option<Vec<u8>> {
    let count = changes.len();
    if count == 0 {
        return None;
    }

    let mut buf = Vec::with_capacity(count * 512 + 128);

    // Format version
    buf.push(1u8);
    // Point count
    buf.extend_from_slice(&(count as u32).to_le_bytes());
    // Batch timestamp
    write_str(&mut buf, timestamp);

    for &(idx, ref dv) in changes {
        let node = &nodes[idx];

        // Build bitmask — bits must match ipc decode order
        let mut mask: u32 = 0;
        // OPT_NAMES_A: bits 0-5
        if node.device_id.is_some() {
            mask |= 1;
        }
        if node.endpoint_uuid.is_some() {
            mask |= 1 << 1;
        }
        if node.device_uuid.is_some() {
            mask |= 1 << 2;
        }
        if node.protocol.is_some() {
            mask |= 1 << 3;
        }
        if node.resolved_display_name.is_some() {
            mask |= 1 << 4;
        }
        if node.device_display_name.is_some() {
            mask |= 1 << 5;
        }
        // OPT_NAMES_B: bits 6-12 (bit 6 = qualityCode, unused here)
        if node.raw_object_name.is_some() {
            mask |= 1 << 7;
        }
        if node.raw_point_name.is_some() {
            mask |= 1 << 8;
        }
        if node.normalization_name.is_some() {
            mask |= 1 << 9;
        }
        if node.normalization_device_name.is_some() {
            mask |= 1 << 10;
        }
        if node.source_endpoint_name.is_some() {
            mask |= 1 << 11;
        }
        if node.point_uuid.is_some() {
            mask |= 1 << 12;
        }
        if node.writable == Some(true) {
            mask |= 1 << 13;
        }
        if node.unit.is_some() {
            mask |= 1 << 14;
        }

        buf.extend_from_slice(&mask.to_le_bytes());

        // Per-reading timestamp
        write_str(&mut buf, timestamp);

        // deviceName
        write_str(&mut buf, &node.device_name);

        // Optional fields A (bits 0-5) — between deviceName and metric
        if let Some(ref v) = node.device_id {
            write_str(&mut buf, v);
        }
        if let Some(ref v) = node.endpoint_uuid {
            write_str(&mut buf, v);
        }
        if let Some(ref v) = node.device_uuid {
            write_str(&mut buf, v);
        }
        if let Some(ref v) = node.protocol {
            write_str(&mut buf, v);
        }
        if let Some(ref v) = node.resolved_display_name {
            write_str(&mut buf, v);
        }
        if let Some(ref v) = node.device_display_name {
            write_str(&mut buf, v);
        }

        // metric
        write_str(&mut buf, &node.metric);

        // Typed value: vtype byte + data
        match &dv.value {
            None => buf.push(0u8),
            Some(v) => match v {
                Variant::Boolean(b) => buf.push(if *b { 2u8 } else { 3u8 }),
                Variant::SByte(n) => {
                    buf.push(1u8);
                    buf.extend_from_slice(&(*n as f64).to_le_bytes());
                }
                Variant::Byte(n) => {
                    buf.push(1u8);
                    buf.extend_from_slice(&(*n as f64).to_le_bytes());
                }
                Variant::Int16(n) => {
                    buf.push(1u8);
                    buf.extend_from_slice(&(*n as f64).to_le_bytes());
                }
                Variant::UInt16(n) => {
                    buf.push(1u8);
                    buf.extend_from_slice(&(*n as f64).to_le_bytes());
                }
                Variant::Int32(n) => {
                    buf.push(1u8);
                    buf.extend_from_slice(&(*n as f64).to_le_bytes());
                }
                Variant::UInt32(n) => {
                    buf.push(1u8);
                    buf.extend_from_slice(&(*n as f64).to_le_bytes());
                }
                Variant::Int64(n) => {
                    buf.push(1u8);
                    buf.extend_from_slice(&(*n as f64).to_le_bytes());
                }
                Variant::UInt64(n) => {
                    buf.push(1u8);
                    buf.extend_from_slice(&(*n as f64).to_le_bytes());
                }
                Variant::Float(n) => {
                    buf.push(1u8);
                    buf.extend_from_slice(&(*n as f64).to_le_bytes());
                }
                Variant::Double(n) => {
                    buf.push(1u8);
                    buf.extend_from_slice(&n.to_le_bytes());
                }
                Variant::String(s) => {
                    buf.push(4u8);
                    write_str(&mut buf, s.as_ref());
                }
                other => {
                    buf.push(4u8);
                    write_str(&mut buf, &format!("{other:?}"));
                }
            },
        }

        // Unit — conditional on bit 14
        if let Some(ref u) = node.unit {
            write_str(&mut buf, u);
        }

        // Quality: 0=GOOD, 1=BAD, 2=UNCERTAIN
        let quality: u8 = match dv.status.as_ref() {
            Some(s) if s.is_good() => 0,
            Some(s) if s.is_uncertain() => 2,
            Some(_) => 1,
            None => 0,
        };
        buf.push(quality);

        // Optional fields B (bits 6-12)
        // bit 6 = qualityCode (not set by this encoder)
        if let Some(ref v) = node.raw_object_name {
            write_str(&mut buf, v);
        }
        if let Some(ref v) = node.raw_point_name {
            write_str(&mut buf, v);
        }
        if let Some(ref v) = node.normalization_name {
            write_str(&mut buf, v);
        }
        if let Some(ref v) = node.normalization_device_name {
            write_str(&mut buf, v);
        }
        if let Some(ref v) = node.source_endpoint_name {
            write_str(&mut buf, v);
        }
        if let Some(ref v) = node.point_uuid {
            write_str(&mut buf, v);
        }
        // bit 13 (writable) is mask-only, no data bytes
    }

    Some(buf)
}

// ---- Reconnection constants ----

const WATCHDOG_CHECK_INTERVAL: Duration = Duration::from_secs(5);
const MIN_RECONNECT_DELAY: Duration = Duration::from_secs(5);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(60);

// ---- Main subscriber ----

struct SubscribeParams {
    nodes: Vec<NodeConfig>,
    publishing_interval_ms: f64,
    sampling_interval_ms: f64,
    on_data: Arc<ThreadsafeFunction<Buffer, ErrorStrategy::Fatal>>,
}

struct SubscriberInner {
    config: SubscriberConfig,
    stats: Stats,
    session: parking_lot::Mutex<Option<Arc<RwLock<Session>>>>,
    session_loop_tx: parking_lot::Mutex<Option<oneshot::Sender<SessionCommand>>>,
    node_configs: parking_lot::Mutex<Vec<NodeConfig>>,
    node_id_to_index: parking_lot::Mutex<HashMap<u32, usize>>,
    subscribe_params: parking_lot::Mutex<Option<SubscribeParams>>,
    watchdog_stop: AtomicBool,
}

#[napi]
pub struct OpcuaSubscriber {
    inner: Arc<SubscriberInner>,
}

// ---- Internal connect/subscribe logic (used by both initial call and reconnect) ----

fn do_connect(inner: &SubscriberInner) -> std::result::Result<(), String> {
    let config = &inner.config;

    let security_policy = match config
        .security_policy
        .as_deref()
        .unwrap_or("None")
    {
        "None" => SecurityPolicy::None,
        "Basic128Rsa15" => SecurityPolicy::Basic128Rsa15,
        "Basic256" => SecurityPolicy::Basic256,
        "Basic256Sha256" => SecurityPolicy::Basic256Sha256,
        "Aes128Sha256RsaOaep" => SecurityPolicy::Aes128Sha256RsaOaep,
        "Aes256Sha256RsaPss" => SecurityPolicy::Aes256Sha256RsaPss,
        other => {
            return Err(format!("Unsupported security policy: {other}"));
        }
    };

    let security_mode = match config
        .security_mode
        .as_deref()
        .unwrap_or("None")
    {
        "None" => MessageSecurityMode::None,
        "Sign" => MessageSecurityMode::Sign,
        "SignAndEncrypt" => MessageSecurityMode::SignAndEncrypt,
        other => {
            return Err(format!("Unsupported security mode: {other}"));
        }
    };

    let app_name = config
        .application_name
        .as_deref()
        .unwrap_or("iot-agent-rust-subscriber");

    let mut builder = ClientBuilder::new()
        .application_name(app_name)
        .application_uri(format!("urn:{app_name}"))
        .product_uri("urn:iot-agent:opcua-subscriber")
        .trust_server_certs(
            config.certificate_trust_mode.as_deref() == Some("trustAll"),
        )
        .session_retry_limit(3);

    if let Some(timeout) = config.session_timeout_ms {
        builder = builder.session_timeout(timeout);
    }

    let client = builder.client();
    if client.is_none() {
        return Err("Failed to create OPC UA client from config".into());
    }
    let mut client = client.unwrap();

    let endpoint = EndpointDescription::from((
        config.endpoint_url.as_str(),
        security_policy.to_str(),
        security_mode,
    ));

    let identity = match (&config.username, &config.password) {
        (Some(user), Some(pass)) => {
            IdentityToken::UserName(user.clone(), pass.clone())
        }
        _ => IdentityToken::Anonymous,
    };

    eprintln!(
        "[opcua-rust] Connecting to {} (security={:?}, mode={:?})",
        config.endpoint_url, security_policy, security_mode
    );

    let session = client
        .connect_to_endpoint(endpoint, identity)
        .map_err(|e| format!("OPC UA connect failed: {e}"))?;

    let tx = Session::run_async(session.clone());

    inner.stats.connected.store(true, Ordering::Relaxed);
    *inner.stats.started_at.lock() = Some(Instant::now());
    *inner.session.lock() = Some(session);
    *inner.session_loop_tx.lock() = Some(tx);

    eprintln!("[opcua-rust] Connected successfully (session loop started)");
    Ok(())
}

fn do_teardown(inner: &SubscriberInner) {
    if let Some(tx) = inner.session_loop_tx.lock().take() {
        let _ = tx.send(SessionCommand::Stop);
    }
    let session = inner.session.lock().take();
    if let Some(session) = session {
        let s = session.write();
        s.disconnect();
    }
    inner.stats.connected.store(false, Ordering::Relaxed);
    inner.node_id_to_index.lock().clear();
    inner.stats.subscribed_nodes.store(0, Ordering::Relaxed);
}

fn do_subscribe_arc(inner_arc: &Arc<SubscriberInner>) -> std::result::Result<(), String> {
    let inner = inner_arc.as_ref();
    let params = {
        let guard = inner.subscribe_params.lock();
        match guard.as_ref() {
            Some(p) => SubscribeParams {
                nodes: p.nodes.clone(),
                publishing_interval_ms: p.publishing_interval_ms,
                sampling_interval_ms: p.sampling_interval_ms,
                on_data: p.on_data.clone(),
            },
            None => return Err("No subscribe params stored".into()),
        }
    };

    let session_arc = {
        let guard = inner.session.lock();
        guard.as_ref().ok_or("Not connected")?.clone()
    };

    let nodes = &params.nodes;
    let publishing_interval_ms = params.publishing_interval_ms;
    let sampling_interval_ms = params.sampling_interval_ms;
    let on_data = &params.on_data;
    let node_count = nodes.len();

    // Phase 1: Pre-validate nodes via batch Read
    let validate_chunk = 500;
    let mut valid_indices: Vec<usize> = Vec::with_capacity(node_count);
    let mut invalid_count = 0usize;
    let validation_start = Instant::now();

    eprintln!("[opcua-rust] Pre-validating {} nodes...", node_count);

    for chunk_start in (0..node_count).step_by(validate_chunk) {
        let chunk_end = std::cmp::min(chunk_start + validate_chunk, node_count);
        let read_ids: Vec<ReadValueId> = (chunk_start..chunk_end)
            .map(|i| ReadValueId {
                node_id: NodeId::from_str(&nodes[i].node_id)
                    .unwrap_or(NodeId::null()),
                attribute_id: AttributeId::Value as u32,
                index_range: UAString::null(),
                data_encoding: QualifiedName::null(),
            })
            .collect();

        let result = {
            let s = session_arc.read();
            s.read(&read_ids, TimestampsToReturn::Neither, 0.0)
        };

        match result {
            Ok(results) => {
                for (j, dv) in results.iter().enumerate() {
                    let good = match dv.status.as_ref() {
                        None => true,
                        Some(s) => s.is_good(),
                    };
                    if good {
                        valid_indices.push(chunk_start + j);
                    } else {
                        invalid_count += 1;
                    }
                }
            }
            Err(e) => {
                eprintln!(
                    "[opcua-rust] Pre-validation read failed at offset {}: {e} — including all in chunk",
                    chunk_start
                );
                for i in chunk_start..chunk_end {
                    valid_indices.push(i);
                }
            }
        }

        if chunk_start > 0 && chunk_start % 5000 == 0 {
            eprintln!(
                "[opcua-rust] Pre-validation: {}/{} checked, {} invalid so far",
                chunk_start, node_count, invalid_count
            );
        }

        std::thread::sleep(Duration::from_millis(1));
    }

    let valid_count = valid_indices.len();
    eprintln!(
        "[opcua-rust] Pre-validation done: {}/{} valid, {} filtered out ({:.1}s)",
        valid_count,
        node_count,
        invalid_count,
        validation_start.elapsed().as_secs_f64()
    );

    if valid_count == 0 {
        eprintln!("[opcua-rust] No valid nodes to subscribe to");
        *inner.node_configs.lock() = nodes.clone();
        return Ok(());
    }

    *inner.node_configs.lock() = nodes.clone();
    inner.node_id_to_index.lock().clear();

    // Phase 2: Create subscriptions
    let max_items_per_sub = 1000;
    let sub_count = (valid_count + max_items_per_sub - 1) / max_items_per_sub;
    let chunk_size = 100;
    let mut total_created = 0;
    let mut skipped_chunks = 0;

    eprintln!(
        "[opcua-rust] Creating {} subscription(s) for {} valid nodes",
        sub_count, valid_count
    );

    let mut session_dead = false;

    for sub_idx in 0..sub_count {
        if session_dead {
            break;
        }

        let sub_start = sub_idx * max_items_per_sub;
        let sub_end =
            std::cmp::min(sub_start + max_items_per_sub, valid_count);
        let sub_valid = &valid_indices[sub_start..sub_end];

        {
            let s = session_arc.read();
            if !s.is_connected() {
                eprintln!(
                    "[opcua-rust] Session disconnected before creating subscription {}",
                    sub_idx
                );
                session_dead = true;
                break;
            }
        }

        let subscription_id = match std::panic::catch_unwind(
            std::panic::AssertUnwindSafe(|| {
            let s = session_arc.read();
            s.create_subscription(
                publishing_interval_ms,
                100,
                50,
                0,
                0,
                true,
                {
                    let cb_inner = inner_arc.clone();
                    let on_data = on_data.clone();
                    DataChangeCallback::new(move |items| {
                        let configs = cb_inner.node_configs.lock();
                        let id_map = cb_inner.node_id_to_index.lock();

                        let timestamp = chrono::Utc::now()
                            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                            .to_string();

                        let changes: Vec<(usize, DataValue)> = items
                            .iter()
                            .filter_map(|item| {
                                let handle = item.client_handle();
                                let idx = id_map.get(&handle)?;
                                Some((*idx, item.last_value().clone()))
                            })
                            .collect();

                        if changes.is_empty() {
                            return;
                        }

                        cb_inner
                            .stats
                            .data_changes
                            .fetch_add(
                                changes.len() as u64,
                                Ordering::Relaxed,
                            );
                        *cb_inner.stats.last_data_change_at.lock() =
                            Some(Instant::now());

                        match encode_batch(
                            &timestamp,
                            &changes,
                            &configs,
                        ) {
                            Some(batch) => {
                                let len = batch.len() as u64;
                                let prev_batches = cb_inner.stats.batches_sent.fetch_add(
                                    1,
                                    Ordering::Relaxed,
                                );
                                cb_inner.stats.bytes_encoded.fetch_add(
                                    len,
                                    Ordering::Relaxed,
                                );
                                if prev_batches == 0 {
                                    eprintln!(
                                        "[opcua-rust] First batch encoded: {} readings, {} bytes (wire format v2: mask+ts+dn+optA+metric+typedVal+unit?+q+optB)",
                                        changes.len(), len
                                    );
                                }
                                let buffer = Buffer::from(batch);
                                on_data.call(
                                    buffer,
                                    ThreadsafeFunctionCallMode::NonBlocking,
                                );
                            }
                            None => {
                                cb_inner.stats.encode_errors.fetch_add(
                                    1,
                                    Ordering::Relaxed,
                                );
                            }
                        }
                    })
                },
            )
            }))
        {
            Ok(Ok(id)) => id,
            Ok(Err(e)) => {
                eprintln!(
                    "[opcua-rust] create_subscription failed (sub {}): {e} — skipping",
                    sub_idx
                );
                continue;
            }
            Err(_panic) => {
                eprintln!(
                    "[opcua-rust] create_subscription panicked (sub {}) — session likely dead",
                    sub_idx
                );
                session_dead = true;
                break;
            }
        };

        eprintln!(
            "[opcua-rust] Subscription {} created (interval={}ms, items={}, batch {}/{})",
            subscription_id,
            publishing_interval_ms,
            sub_valid.len(),
            sub_idx + 1,
            sub_count
        );

        for (chunk_idx, chunk) in sub_valid.chunks(chunk_size).enumerate()
        {
            let items_to_create: Vec<MonitoredItemCreateRequest> = chunk
                .iter()
                .map(|&orig_idx| {
                    let node_id =
                        NodeId::from_str(&nodes[orig_idx].node_id)
                            .unwrap_or(NodeId::null());
                    MonitoredItemCreateRequest {
                        item_to_monitor: ReadValueId {
                            node_id,
                            attribute_id: AttributeId::Value as u32,
                            index_range: UAString::null(),
                            data_encoding: QualifiedName::null(),
                        },
                        monitoring_mode: MonitoringMode::Reporting,
                        requested_parameters: MonitoringParameters {
                            client_handle: orig_idx as u32,
                            sampling_interval: sampling_interval_ms,
                            queue_size: 1,
                            discard_oldest: true,
                            ..Default::default()
                        },
                    }
                })
                .collect();

            let max_retries = 3u32;
            let mut attempt_results = None;
            for attempt in 0..=max_retries {
                {
                    let s = session_arc.read();
                    if !s.is_connected() {
                        eprintln!(
                            "[opcua-rust] Session disconnected — aborting subscribe at sub {}, chunk {}",
                            sub_idx, chunk_idx
                        );
                        session_dead = true;
                        break;
                    }
                }

                let call_result = std::panic::catch_unwind(
                    std::panic::AssertUnwindSafe(|| {
                        let s = session_arc.read();
                        s.create_monitored_items(
                            subscription_id,
                            TimestampsToReturn::Both,
                            &items_to_create,
                        )
                    }),
                );
                match call_result {
                    Ok(Ok(r)) => {
                        attempt_results = Some(r);
                        break;
                    }
                    Ok(Err(e)) => {
                        if attempt < max_retries {
                            let backoff_ms = 1000 * (1u64 << attempt);
                            eprintln!(
                                "[opcua-rust] create_monitored_items timeout (sub {}, chunk {}, attempt {}/{}) — retrying in {}ms",
                                sub_idx, chunk_idx, attempt + 1, max_retries + 1, backoff_ms
                            );
                            std::thread::sleep(
                                Duration::from_millis(backoff_ms),
                            );
                        } else {
                            eprintln!(
                                "[opcua-rust] create_monitored_items failed after {} attempts (sub {}, chunk {}): {e} — skipping",
                                max_retries + 1, sub_idx, chunk_idx
                            );
                            skipped_chunks += 1;
                        }
                    }
                    Err(_panic) => {
                        eprintln!(
                            "[opcua-rust] create_monitored_items panicked (sub {}, chunk {}) — session likely dead, aborting subscribe",
                            sub_idx, chunk_idx
                        );
                        session_dead = true;
                        break;
                    }
                }
            }

            if session_dead {
                eprintln!(
                    "[opcua-rust] Aborting subscription setup — created {} items before session loss",
                    total_created
                );
                break;
            }

            if let Some(results) = attempt_results {
                let mut id_map = inner.node_id_to_index.lock();
                for (i, result) in results.iter().enumerate() {
                    let orig_idx = chunk[i];
                    if result.status_code.is_good() {
                        id_map.insert(orig_idx as u32, orig_idx);
                        total_created += 1;
                    }
                }
            }

            std::thread::sleep(Duration::from_millis(10));
        } // end chunk loop

        std::thread::sleep(Duration::from_millis(200));
    } // end subscription loop

    inner
        .stats
        .subscribed_nodes
        .store(total_created as u64, Ordering::Relaxed);

    eprintln!(
        "[opcua-rust] Subscribed to {}/{} nodes across {} subscription(s){}",
        total_created,
        valid_count,
        sub_count,
        if skipped_chunks > 0 {
            format!(" ({} chunks skipped)", skipped_chunks)
        } else {
            String::new()
        }
    );

    Ok(())
}

fn check_session_alive(inner: &SubscriberInner) -> bool {
    if !inner.stats.connected.load(Ordering::Relaxed) {
        return false;
    }
    if let Some(session) = inner.session.lock().as_ref() {
        session.read().is_connected()
    } else {
        false
    }
}

fn start_watchdog(inner: Arc<SubscriberInner>) {
    std::thread::Builder::new()
        .name("opcua-watchdog".into())
        .spawn(move || {
            set_thread_name("opcua-watchdog");
            let mut current_delay = MIN_RECONNECT_DELAY;

            eprintln!("[opcua-rust] Watchdog started (check={}s)", WATCHDOG_CHECK_INTERVAL.as_secs());

            loop {
                std::thread::sleep(WATCHDOG_CHECK_INTERVAL);

                if inner.watchdog_stop.load(Ordering::Relaxed) {
                    eprintln!("[opcua-rust] Watchdog stopping (shutdown requested)");
                    break;
                }

                if check_session_alive(&inner) {
                    // Connection healthy — reset backoff
                    current_delay = MIN_RECONNECT_DELAY;
                    continue;
                }

                // Connection lost
                let reconnects = inner.stats.reconnect_count.load(Ordering::Relaxed);
                eprintln!(
                    "[opcua-rust] Watchdog detected disconnect (previous reconnects: {})",
                    reconnects
                );

                // Reconnection loop with exponential backoff
                loop {
                    if inner.watchdog_stop.load(Ordering::Relaxed) {
                        eprintln!("[opcua-rust] Watchdog stopping during reconnect (shutdown requested)");
                        return;
                    }

                    // Jitter: 0-500ms
                    let jitter_ms = (rand_u32() % 500) as u64;
                    let total_delay = current_delay + Duration::from_millis(jitter_ms);

                    eprintln!(
                        "[opcua-rust] Reconnecting in {:.1}s (base={}s, jitter={}ms)",
                        total_delay.as_secs_f64(),
                        current_delay.as_secs(),
                        jitter_ms
                    );

                    std::thread::sleep(total_delay);

                    if inner.watchdog_stop.load(Ordering::Relaxed) {
                        return;
                    }

                    // Tear down old session
                    do_teardown(&inner);

                    // Attempt reconnect
                    match do_connect(&inner) {
                        Ok(()) => {
                            eprintln!("[opcua-rust] Reconnected — resubscribing...");
                            match do_subscribe_arc(&inner) {
                                Ok(()) => {
                                    inner.stats.reconnect_count.fetch_add(1, Ordering::Relaxed);
                                    let total = inner.stats.reconnect_count.load(Ordering::Relaxed);
                                    let nodes = inner.stats.subscribed_nodes.load(Ordering::Relaxed);
                                    eprintln!(
                                        "[opcua-rust] Reconnect successful (attempt #{}, {} nodes subscribed)",
                                        total, nodes
                                    );
                                    current_delay = MIN_RECONNECT_DELAY;
                                    break; // Back to health-check loop
                                }
                                Err(e) => {
                                    eprintln!("[opcua-rust] Resubscribe failed after reconnect: {e}");
                                    inner.stats.reconnect_failures.fetch_add(1, Ordering::Relaxed);
                                    do_teardown(&inner);
                                }
                            }
                        }
                        Err(e) => {
                            inner.stats.reconnect_failures.fetch_add(1, Ordering::Relaxed);
                            let failures = inner.stats.reconnect_failures.load(Ordering::Relaxed);
                            eprintln!(
                                "[opcua-rust] Reconnect failed (failures: {}): {e}",
                                failures
                            );
                        }
                    }

                    // Exponential backoff
                    current_delay = std::cmp::min(current_delay * 2, MAX_RECONNECT_DELAY);
                }
            }
        })
        .expect("Failed to spawn opcua-watchdog thread");
}

// Simple deterministic-ish random for jitter (no external crate needed)
fn rand_u32() -> u32 {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    // Mix nanoseconds for jitter variance
    (t.subsec_nanos() ^ (t.as_secs() as u32).wrapping_mul(2654435761)) % 1000
}

// ---- NAPI interface ----

#[napi]
impl OpcuaSubscriber {
    #[napi(constructor)]
    pub fn new(config: SubscriberConfig) -> Self {
        eprintln!(
            "[opcua-rust] Subscriber created for {}",
            config.endpoint_url
        );
        Self {
            inner: Arc::new(SubscriberInner {
                config,
                stats: Stats::new(),
                session: parking_lot::Mutex::new(None),
                session_loop_tx: parking_lot::Mutex::new(None),
                node_configs: parking_lot::Mutex::new(Vec::new()),
                node_id_to_index: parking_lot::Mutex::new(HashMap::new()),
                subscribe_params: parking_lot::Mutex::new(None),
                watchdog_stop: AtomicBool::new(false),
            }),
        }
    }

    #[napi]
    pub async fn connect(&self) -> Result<()> {
        let inner = self.inner.clone();

        tokio::task::spawn_blocking(move || -> Result<()> {
            set_thread_name("opcua-connect");
            do_connect(&inner).map_err(|e| Error::from_reason(e))
        })
        .await
        .map_err(|e| Error::from_reason(format!("Connect task panicked: {e}")))?
    }

    #[napi]
    pub async fn subscribe(
        &self,
        nodes: Vec<NodeConfig>,
        publishing_interval_ms: f64,
        sampling_interval_ms: f64,
        on_data: ThreadsafeFunction<Buffer, ErrorStrategy::Fatal>,
    ) -> Result<()> {
        let inner = self.inner.clone();
        let on_data = Arc::new(on_data);

        // Store params for reconnection
        {
            *inner.subscribe_params.lock() = Some(SubscribeParams {
                nodes: nodes.clone(),
                publishing_interval_ms,
                sampling_interval_ms,
                on_data: on_data.clone(),
            });
        }

        // Store node configs early so the watchdog has them
        *inner.node_configs.lock() = nodes;

        let inner2 = inner.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            set_thread_name("opcua-subscribe");
            do_subscribe_arc(&inner2).map_err(|e| Error::from_reason(e))
        })
        .await
        .map_err(|e| Error::from_reason(format!("Subscribe task panicked: {e}")))?;

        // Start watchdog after successful initial subscribe
        inner.watchdog_stop.store(false, Ordering::Relaxed);
        start_watchdog(inner);

        Ok(())
    }

    #[napi]
    pub async fn disconnect(&self) -> Result<()> {
        let inner = self.inner.clone();

        // Signal watchdog to stop
        inner.watchdog_stop.store(true, Ordering::Relaxed);

        tokio::task::spawn_blocking(move || {
            set_thread_name("opcua-disconnect");
            do_teardown(&inner);
            inner.node_configs.lock().clear();
            eprintln!("[opcua-rust] Disconnected");
        })
        .await
        .map_err(|e| Error::from_reason(format!("Disconnect task panicked: {e}")))?;

        Ok(())
    }

    #[napi]
    pub fn is_connected(&self) -> bool {
        check_session_alive(&self.inner)
    }

    #[napi]
    pub fn get_stats(&self) -> String {
        let stats = &self.inner.stats;
        let uptime = stats
            .started_at
            .lock()
            .map(|i| i.elapsed().as_secs())
            .unwrap_or(0);
        let last_data = stats
            .last_data_change_at
            .lock()
            .map(|i| i.elapsed().as_secs())
            .unwrap_or(0);
        let data_changes = stats.data_changes.load(Ordering::Relaxed);
        let rate = if uptime > 0 {
            data_changes as f64 / uptime as f64
        } else {
            0.0
        };

        format!(
            "connected={} nodes={} data_changes={} batches={} encoded={:.1}MB rate={:.0}/s uptime={}s last_data={}s_ago cb_errors={} enc_errors={} reconnects={} reconnect_failures={}",
            stats.connected.load(Ordering::Relaxed),
            stats.subscribed_nodes.load(Ordering::Relaxed),
            data_changes,
            stats.batches_sent.load(Ordering::Relaxed),
            stats.bytes_encoded.load(Ordering::Relaxed) as f64 / 1_048_576.0,
            rate,
            uptime,
            last_data,
            stats.callback_errors.load(Ordering::Relaxed),
            stats.encode_errors.load(Ordering::Relaxed),
            stats.reconnect_count.load(Ordering::Relaxed),
            stats.reconnect_failures.load(Ordering::Relaxed),
        )
    }

    #[napi]
    pub fn get_subscribed_count(&self) -> u32 {
        self.inner.stats.subscribed_nodes.load(Ordering::Relaxed) as u32
    }

    #[napi]
    pub fn get_data_change_count(&self) -> f64 {
        self.inner.stats.data_changes.load(Ordering::Relaxed) as f64
    }
}
