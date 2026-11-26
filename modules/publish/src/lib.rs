use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::time::Instant;

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
fn set_thread_name(_name: &str) {}

// ── Existing serialize_payload types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone)]
pub struct SerializeResult {
    pub json_string: String,
    pub json_bytes: u32,
    pub compressed: Option<Buffer>,
    pub compressed_bytes: u32,
    pub compression_ratio: f64,
    pub serialize_ms: f64,
    pub compress_ms: f64,
    pub total_ms: f64,
}

// ── process_batch types ──────────────────────────────────────────────────────

#[napi(object)]
#[derive(Clone)]
pub struct BatchConfig {
    pub payload_format: String,
    pub max_readings_per_chunk: u32,
    pub max_packet_size_bytes: Option<u32>,
    pub filter_bad_quality: bool,
    pub compress: bool,
    pub compression_level: Option<i32>,
    pub external_node_name: String,
    pub external_group_name: String,
    pub timestamp_ms: f64,
    pub timestamp_iso: Option<String>,
    pub protocol: Option<String>,
    pub msg_id: Option<String>,
    pub ml_schema: Option<String>,
    pub context: Option<Value>,
    pub dataset: Option<DatasetConfig>,
}

#[napi(object)]
#[derive(Clone)]
pub struct DatasetConfig {
    pub id: String,
    pub name: String,
    pub window_secs: Option<f64>,
    pub missing_values: Option<String>,
    pub normalization: Option<String>,
    pub exclude_bad_quality: Option<bool>,
    pub remove_outliers: Option<bool>,
    pub outlier_method: Option<String>,
    pub output_format: Option<String>,
}

#[napi(object)]
pub struct ProcessedChunk {
    pub chunk_index: u32,
    pub total_chunks: u32,
    pub readings_in_chunk: u32,
    pub json_string: Option<String>,
    pub compressed: Option<Buffer>,
    pub json_bytes: u32,
    pub compressed_bytes: u32,
    pub compression_ratio: f64,
}

#[napi(object)]
pub struct BatchTiming {
    pub flatten_ms: f64,
    pub chunk_ms: f64,
    pub enrich_ms: f64,
    pub serialize_ms: f64,
    pub compress_ms: f64,
    pub total_ms: f64,
}

#[napi(object)]
pub struct BatchResult {
    pub chunks: Vec<ProcessedChunk>,
    pub quarantined_count: u32,
    pub failed_count: u32,
    pub total_readings_input: u32,
    pub successfully_chunked: u32,
    pub timing: BatchTiming,
}

// ── NAPI exports ─────────────────────────────────────────────────────────────

#[napi]
pub struct PublishFormatter;

#[napi]
impl PublishFormatter {
    #[napi]
    pub async fn serialize_payload(
        payload: Value,
        compress: bool,
        compression_level: Option<i32>,
    ) -> Result<SerializeResult> {
        tokio::task::spawn_blocking(move || {
            set_thread_name("publish-legacy");
            serialize_payload_impl(payload, compress, compression_level.unwrap_or(3))
        })
        .await
        .map_err(|e| Error::from_reason(format!("Task panicked: {e}")))?
    }

    #[napi]
    pub async fn process_batch(
        messages: Value,
        config: BatchConfig,
    ) -> Result<BatchResult> {
        tokio::task::spawn_blocking(move || {
            set_thread_name("publish-batch");
            process_batch_impl(messages, config)
        })
        .await
        .map_err(|e| Error::from_reason(format!("Task panicked: {e}")))?
    }

    #[napi]
    pub async fn process_batch_from_json(
        json_buf: Buffer,
        config: BatchConfig,
    ) -> Result<BatchResult> {
        let json_bytes = json_buf.to_vec();
        tokio::task::spawn_blocking(move || {
            set_thread_name("publish-batch");
            let messages: Value = serde_json::from_slice(&json_bytes)
                .map_err(|e| Error::from_reason(format!("JSON parse: {e}")))?;
            process_batch_impl(messages, config)
        })
        .await
        .map_err(|e| Error::from_reason(format!("Task panicked: {e}")))?
    }
}

// ── serialize_payload implementation (unchanged) ─────────────────────────────

fn serialize_payload_impl(
    payload: Value,
    compress: bool,
    compression_level: i32,
) -> Result<SerializeResult> {
    let start = Instant::now();

    let serialize_start = Instant::now();
    let json_string = serde_json::to_string(&payload)
        .map_err(|e| Error::new(napi::Status::GenericFailure, format!("JSON serialization failed: {e}")))?;
    let json_bytes = json_string.len() as u32;
    let serialize_ms = serialize_start.elapsed().as_secs_f64() * 1000.0;

    let mut compressed: Option<Buffer> = None;
    let mut compressed_bytes: u32 = json_bytes;
    let mut compression_ratio: f64 = 1.0;
    let mut compress_ms: f64 = 0.0;

    if compress {
        let compress_start = Instant::now();
        match zstd::encode_all(json_string.as_bytes(), compression_level) {
            Ok(data) => {
                compressed_bytes = data.len() as u32;
                compression_ratio = if json_bytes > 0 {
                    compressed_bytes as f64 / json_bytes as f64
                } else {
                    1.0
                };
                compressed = Some(data.into());
            }
            Err(_) => {}
        }
        compress_ms = compress_start.elapsed().as_secs_f64() * 1000.0;
    }

    let total_ms = start.elapsed().as_secs_f64() * 1000.0;

    Ok(SerializeResult {
        json_string,
        json_bytes,
        compressed,
        compressed_bytes,
        compression_ratio,
        serialize_ms,
        compress_ms,
        total_ms,
    })
}

// ── process_batch implementation ─────────────────────────────────────────────

fn process_batch_impl(messages: Value, config: BatchConfig) -> Result<BatchResult> {
    let total_start = Instant::now();

    // Phase 1: Flatten
    let flatten_start = Instant::now();
    let flat = flatten_messages(&messages);
    let flatten_ms = flatten_start.elapsed().as_secs_f64() * 1000.0;
    let total_readings_input = flat.len() as u32;

    // Phase 2: Size estimation + chunking
    let chunk_start = Instant::now();
    let max_per_chunk = config.max_readings_per_chunk as usize;
    let max_packet = config.max_packet_size_bytes.unwrap_or(1_048_576) as usize;
    let (chunks, quarantined_count) = chunk_readings(&flat, max_per_chunk, max_packet);
    let total_chunks = chunks.len() as u32;
    let chunk_ms = chunk_start.elapsed().as_secs_f64() * 1000.0;

    // Phase 3-5: Enrich + Serialize + Compress per chunk
    let enrich_start = Instant::now();
    let mut processed: Vec<ProcessedChunk> = Vec::with_capacity(chunks.len());
    let mut total_serialize_ms = 0.0_f64;
    let mut total_compress_ms = 0.0_f64;
    let mut successfully_chunked = 0_u32;
    let format = config.payload_format.as_str();
    let compress_level = config.compression_level.unwrap_or(3);

    for (chunk_idx, chunk) in chunks.into_iter().enumerate() {
        let reading_count = chunk.len() as u32;
        successfully_chunked += reading_count;

        // Enrich
        let envelope = match format {
            "tags" | "ecp" => {
                let tags: Vec<Value> = chunk
                    .iter()
                    .enumerate()
                    .filter_map(|(i, r)| enrich_tag_payload(r, i, format, config.filter_bad_quality))
                    .collect();
                let final_tags = if format == "ecp" { dedup_ecp_tags(tags) } else { tags };
                build_tags_envelope(&config, final_tags)
            }
            "ml" => {
                let features: Vec<Value> = chunk
                    .iter()
                    .enumerate()
                    .map(|(i, r)| enrich_ml_feature_payload(r, i))
                    .collect();
                build_ml_envelope(&config, features)
            }
            "custom" => {
                let raw: Vec<Value> = chunk.iter().map(|r| (*r).clone()).collect();
                build_custom_envelope(&config, raw)
            }
            _ => {
                return Err(Error::from_reason(format!("Unknown payload format: {format}")));
            }
        };

        // Serialize
        let s_start = Instant::now();
        let json = serde_json::to_string(&envelope)
            .map_err(|e| Error::new(napi::Status::GenericFailure, format!("Serialization failed: {e}")))?;
        let json_bytes = json.len() as u32;
        total_serialize_ms += s_start.elapsed().as_secs_f64() * 1000.0;

        // Compress
        let c_start = Instant::now();
        let (json_string, compressed, compressed_bytes, compression_ratio) = if config.compress {
            match zstd::encode_all(json.as_bytes(), compress_level) {
                Ok(data) => {
                    let cb = data.len() as u32;
                    let r = if json_bytes > 0 { cb as f64 / json_bytes as f64 } else { 1.0 };
                    (None, Some(Buffer::from(data)), cb, r)
                }
                Err(_) => (Some(json), None, json_bytes, 1.0),
            }
        } else {
            (Some(json), None, json_bytes, 1.0)
        };
        total_compress_ms += c_start.elapsed().as_secs_f64() * 1000.0;

        processed.push(ProcessedChunk {
            chunk_index: chunk_idx as u32,
            total_chunks,
            readings_in_chunk: reading_count,
            json_string,
            compressed,
            json_bytes,
            compressed_bytes,
            compression_ratio,
        });
    }

    let enrich_ms = enrich_start.elapsed().as_secs_f64() * 1000.0 - total_serialize_ms - total_compress_ms;
    let total_ms = total_start.elapsed().as_secs_f64() * 1000.0;

    Ok(BatchResult {
        chunks: processed,
        quarantined_count: quarantined_count as u32,
        failed_count: 0,
        total_readings_input,
        successfully_chunked,
        timing: BatchTiming {
            flatten_ms,
            chunk_ms,
            enrich_ms,
            serialize_ms: total_serialize_ms,
            compress_ms: total_compress_ms,
            total_ms,
        },
    })
}

// ── Phase 1: Flatten ─────────────────────────────────────────────────────────

fn flatten_messages(messages: &Value) -> Vec<&Value> {
    let arr = match messages.as_array() {
        Some(a) => a,
        None => return vec![],
    };
    let mut out = Vec::with_capacity(arr.len());
    for msg in arr {
        if let Some(readings) = msg.get("readings").and_then(Value::as_array) {
            for reading in readings {
                out.push(reading);
            }
        } else {
            out.push(msg);
        }
    }
    out
}

// ── Phase 2: Size estimation + Chunking ──────────────────────────────────────

fn estimate_json_bytes(v: &Value) -> usize {
    match v {
        Value::Null => 4,
        Value::Bool(true) => 4,
        Value::Bool(false) => 5,
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                let mut buf = itoa::Buffer::new();
                buf.format(i).len()
            } else if let Some(f) = n.as_f64() {
                let mut buf = ryu::Buffer::new();
                buf.format(f).len()
            } else {
                20
            }
        }
        Value::String(s) => s.len() + 2 + count_escape_overhead(s),
        Value::Array(arr) => {
            let inner: usize = arr.iter().map(estimate_json_bytes).sum();
            2 + inner + arr.len().saturating_sub(1) // [] + commas
        }
        Value::Object(map) => {
            let inner: usize = map
                .iter()
                .map(|(k, v)| k.len() + 2 + count_escape_overhead(k) + 1 + estimate_json_bytes(v))
                .sum();
            2 + inner + map.len().saturating_sub(1) // {} + commas
        }
    }
}

fn count_escape_overhead(s: &str) -> usize {
    s.bytes()
        .filter(|&b| b == b'"' || b == b'\\' || b < 0x20)
        .count()
}

fn chunk_readings<'a>(
    readings: &[&'a Value],
    max_per_chunk: usize,
    max_packet_size_bytes: usize,
) -> (Vec<Vec<&'a Value>>, usize) {
    let safety_margin = 0.9;
    let max_safe_bytes = (max_packet_size_bytes as f64 * safety_margin) as usize;
    let max_bytes_per_chunk = max_safe_bytes / 2;

    let mut chunks: Vec<Vec<&Value>> = Vec::new();
    let mut current_chunk: Vec<&Value> = Vec::new();
    let mut current_bytes: usize = 0;
    let mut quarantined = 0_usize;

    for &reading in readings {
        let est = estimate_json_bytes(reading);
        if est > max_safe_bytes {
            quarantined += 1;
            continue;
        }
        let would_exceed_count = current_chunk.len() >= max_per_chunk;
        let would_exceed_bytes = (current_bytes + est) > max_bytes_per_chunk;
        if would_exceed_count || (would_exceed_bytes && !current_chunk.is_empty()) {
            chunks.push(std::mem::take(&mut current_chunk));
            current_bytes = 0;
        }
        current_chunk.push(reading);
        current_bytes += est;
    }
    if !current_chunk.is_empty() {
        chunks.push(current_chunk);
    }
    (chunks, quarantined)
}

// ── Phase 3: Enrichment helpers ──────────────────────────────────────────────

fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                let mut buf = itoa::Buffer::new();
                buf.format(i).to_owned()
            } else if let Some(f) = n.as_f64() {
                let mut buf = ryu::Buffer::new();
                buf.format(f).to_owned()
            } else {
                n.to_string()
            }
        }
        Value::Bool(b) => if *b { "true" } else { "false" }.to_owned(),
        Value::Null => "null".to_owned(),
        _ => serde_json::to_string(v).unwrap_or_default(),
    }
}

fn read_raw_point_name(msg: &Value, index: usize) -> String {
    const KEYS: &[&str] = &[
        "rawPointName",
        "rawObjectName",
        "metric",
        "metric_name",
        "nodeName",
        "name",
        "tag",
        "id",
    ];
    for key in KEYS {
        if let Some(val) = msg.get(*key) {
            if !val.is_null() {
                return value_to_string(val);
            }
        }
    }
    format!("tag_{index}")
}

struct UnitFields {
    unit: Option<String>,
    raw_unit: Option<String>,
}

fn read_normalized_unit(msg: &Value) -> UnitFields {
    let uv = msg.get("unitValue");
    let unit = uv
        .and_then(|u| u.get("unit"))
        .and_then(Value::as_str)
        .or_else(|| msg.get("unit").and_then(Value::as_str))
        .map(String::from);
    let raw_unit = uv
        .and_then(|u| u.get("rawUnit"))
        .and_then(Value::as_str)
        .map(String::from);
    UnitFields { unit, raw_unit }
}

struct QualityFields {
    dq_status: Option<String>,
    dq_unit_confidence: Option<f64>,
    dq_issue_codes: Option<Vec<String>>,
}

fn read_quality_fields(msg: &Value) -> QualityFields {
    let dq = match msg.get("dataQuality") {
        Some(v) if v.is_object() => v,
        _ => {
            return QualityFields {
                dq_status: None,
                dq_unit_confidence: None,
                dq_issue_codes: None,
            }
        }
    };
    let dq_status = dq.get("status").and_then(Value::as_str).map(String::from);
    let dq_unit_confidence = dq
        .get("checks")
        .and_then(|c| c.get("unit"))
        .and_then(|u| u.get("confidence"))
        .and_then(Value::as_f64);
    let dq_issue_codes = build_compact_issue_codes(dq.get("checks"));
    QualityFields { dq_status, dq_unit_confidence, dq_issue_codes }
}

fn build_compact_issue_codes(checks: Option<&Value>) -> Option<Vec<String>> {
    let checks = checks?;
    let mut codes = Vec::new();
    let mut seen = HashSet::new();
    for dimension in &["source", "unit", "value"] {
        if let Some(issues) = checks
            .get(*dimension)
            .and_then(|d| d.get("issues"))
            .and_then(Value::as_array)
        {
            for issue in issues {
                if let Some(code) = issue.get("code").and_then(Value::as_str) {
                    if seen.insert(code.to_owned()) {
                        codes.push(code.to_owned());
                    }
                }
            }
        }
    }
    if codes.is_empty() { None } else { Some(codes) }
}

struct AnomalyFields {
    anomaly_score: Option<f64>,
    anomaly_threshold: Option<f64>,
    baseline_samples: Option<f64>,
    detection_methods: Option<Vec<String>>,
    trend: Option<String>,
    trend_strength: Option<f64>,
    predicted_next: Option<f64>,
    forecast_confidence: Option<f64>,
    device_state: Option<Value>,
    state_duration_seconds: Option<f64>,
}

fn read_anomaly_fields(msg: &Value) -> AnomalyFields {
    AnomalyFields {
        anomaly_score: msg.get("anomaly_score").and_then(Value::as_f64),
        anomaly_threshold: msg.get("anomaly_threshold").and_then(Value::as_f64),
        baseline_samples: msg.get("baseline_samples").and_then(Value::as_f64),
        detection_methods: msg
            .get("detection_methods")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(Value::as_str).map(String::from).collect()),
        trend: msg.get("trend").and_then(Value::as_str).map(String::from),
        trend_strength: msg.get("trend_strength").and_then(Value::as_f64),
        predicted_next: msg.get("predicted_next").and_then(Value::as_f64),
        forecast_confidence: msg.get("forecast_confidence").and_then(Value::as_f64),
        device_state: msg.get("device_state").filter(|v| !v.is_null()).cloned(),
        state_duration_seconds: msg.get("state_duration_seconds").and_then(Value::as_f64),
    }
}

fn apply_enrichment_fields(
    tag: &mut Map<String, Value>,
    unit: &UnitFields,
    quality: &QualityFields,
    anomaly: &AnomalyFields,
) {
    if let Some(ref u) = unit.unit {
        tag.insert("unit".into(), Value::String(u.clone()));
    }
    if let Some(ref ru) = unit.raw_unit {
        tag.insert("rawUnit".into(), Value::String(ru.clone()));
    }
    if let Some(ref s) = quality.dq_status {
        tag.insert("dqStatus".into(), Value::String(s.clone()));
    }
    if let Some(c) = quality.dq_unit_confidence {
        if let Some(n) = serde_json::Number::from_f64(c) {
            tag.insert("dqUnitConfidence".into(), Value::Number(n));
        }
    }
    if let Some(ref codes) = quality.dq_issue_codes {
        tag.insert(
            "dqIssueCodes".into(),
            Value::Array(codes.iter().map(|c| Value::String(c.clone())).collect()),
        );
    }
    macro_rules! opt_f64 {
        ($key:literal, $val:expr) => {
            if let Some(v) = $val {
                if let Some(n) = serde_json::Number::from_f64(v) {
                    tag.insert($key.into(), Value::Number(n));
                }
            }
        };
    }
    opt_f64!("anomaly_score", anomaly.anomaly_score);
    opt_f64!("anomaly_threshold", anomaly.anomaly_threshold);
    opt_f64!("baseline_samples", anomaly.baseline_samples);
    if let Some(ref methods) = anomaly.detection_methods {
        tag.insert(
            "detection_methods".into(),
            Value::Array(methods.iter().map(|m| Value::String(m.clone())).collect()),
        );
    }
    if let Some(ref t) = anomaly.trend {
        tag.insert("trend".into(), Value::String(t.clone()));
    }
    opt_f64!("trend_strength", anomaly.trend_strength);
    opt_f64!("predicted_next", anomaly.predicted_next);
    opt_f64!("forecast_confidence", anomaly.forecast_confidence);
    if let Some(ref ds) = anomaly.device_state {
        tag.insert("device_state".into(), ds.clone());
    }
    opt_f64!("state_duration_seconds", anomaly.state_duration_seconds);
}

// ── Phase 3a: Tags/ECP enrichment ────────────────────────────────────────────

fn enrich_tag_payload(
    msg: &Value,
    index: usize,
    format: &str,
    filter_bad_quality: bool,
) -> Option<Value> {
    let raw_name = read_raw_point_name(msg, index);

    let pi = msg.get("pointIdentity");
    let name = pi
        .and_then(|p| p.get("normalizedName"))
        .and_then(Value::as_str)
        .map(String::from)
        .unwrap_or_else(|| raw_name.clone());
    let provisional_point_id = pi
        .and_then(|p| p.get("provisionalPointId"))
        .and_then(Value::as_str);

    let unit_fields = read_normalized_unit(msg);
    let quality_fields = read_quality_fields(msg);
    let anomaly_fields = read_anomaly_fields(msg);

    let quality_str = msg
        .get("quality")
        .and_then(Value::as_str)
        .map(|s| s.to_uppercase());
    let has_error = msg.get("error").is_some_and(|v| !v.is_null())
        || msg.get("errorCode").is_some_and(|v| !v.is_null())
        || quality_str.as_deref() == Some("BAD")
        || msg.get("qualityCode").is_some_and(|v| !v.is_null());

    if has_error {
        if format == "ecp" && filter_bad_quality {
            return None;
        }
        let error_val = msg
            .get("error")
            .or_else(|| msg.get("errorCode"))
            .or_else(|| msg.get("qualityCode"))
            .cloned()
            .unwrap_or_else(|| Value::String("READ_ERROR".into()));
        let mut tag = Map::new();
        tag.insert("name".into(), Value::String(name));
        tag.insert("rawName".into(), Value::String(raw_name));
        tag.insert("error".into(), error_val);
        apply_enrichment_fields(&mut tag, &unit_fields, &quality_fields, &anomaly_fields);
        if let Some(pid) = provisional_point_id {
            tag.insert("provisionalPointId".into(), Value::String(pid.into()));
        }
        return Some(Value::Object(tag));
    }

    let value = msg
        .get("value")
        .or_else(|| msg.get("rawValue"))
        .cloned()
        .unwrap_or(Value::Null);

    if format == "ecp" {
        if value.is_null() {
            return None;
        }
        let mut tag = Map::new();
        tag.insert("name".into(), Value::String(name));
        tag.insert("rawName".into(), Value::String(raw_name));
        tag.insert("value".into(), value.clone());
        tag.insert("type".into(), Value::Number(infer_ecp_type(&value).into()));
        apply_enrichment_fields(&mut tag, &unit_fields, &quality_fields, &anomaly_fields);
        if let Some(pid) = provisional_point_id {
            tag.insert("provisionalPointId".into(), Value::String(pid.into()));
        }
        return Some(Value::Object(tag));
    }

    // "tags" format
    let mut tag = Map::new();
    tag.insert("name".into(), Value::String(name));
    tag.insert("rawName".into(), Value::String(raw_name));
    tag.insert("value".into(), value);
    apply_enrichment_fields(&mut tag, &unit_fields, &quality_fields, &anomaly_fields);
    if let Some(pid) = provisional_point_id {
        tag.insert("provisionalPointId".into(), Value::String(pid.into()));
    }
    Some(Value::Object(tag))
}

fn infer_ecp_type(value: &Value) -> u8 {
    match value {
        Value::Bool(_) => 1,
        Value::Number(n) => {
            if n.is_i64() || n.is_u64() { 2 } else { 3 }
        }
        _ => 4,
    }
}

fn dedup_ecp_tags(tags: Vec<Value>) -> Vec<Value> {
    let mut map = indexmap::IndexMap::new();
    for tag in tags {
        if let Some(name) = tag.get("name").and_then(Value::as_str) {
            map.insert(name.to_owned(), tag);
        }
    }
    map.into_values().collect()
}

// ── Phase 3b: ML enrichment ─────────────────────────────────────────────────

fn enrich_ml_feature_payload(msg: &Value, index: usize) -> Value {
    let raw_name = read_raw_point_name(msg, index);
    let pi = msg.get("pointIdentity");
    let name = pi
        .and_then(|p| p.get("normalizedName"))
        .and_then(Value::as_str)
        .map(String::from)
        .unwrap_or_else(|| raw_name.clone());

    let quality_str = msg
        .get("quality")
        .and_then(Value::as_str)
        .map(|s| s.to_uppercase());
    let has_error = msg.get("error").is_some_and(|v| !v.is_null())
        || msg.get("errorCode").is_some_and(|v| !v.is_null())
        || quality_str.as_deref() == Some("BAD")
        || msg.get("qualityCode").is_some_and(|v| !v.is_null());

    let mut feature = Map::new();
    feature.insert("name".into(), Value::String(name));
    feature.insert("rawName".into(), Value::String(raw_name));

    if has_error {
        let error_val = msg
            .get("error")
            .or_else(|| msg.get("errorCode"))
            .or_else(|| msg.get("qualityCode"))
            .cloned()
            .unwrap_or_else(|| Value::String("READ_ERROR".into()));
        feature.insert("value".into(), Value::Null);
        feature.insert("dtype".into(), Value::String("error".into()));
        feature.insert("quality".into(), Value::String("BAD".into()));
        feature.insert("error".into(), error_val);
        attach_ml_enrichment(&mut feature, msg);
        return Value::Object(feature);
    }

    let raw_value = msg.get("value").or_else(|| msg.get("rawValue")).cloned();

    match raw_value {
        None | Some(Value::Null) => {
            feature.insert("value".into(), Value::Null);
            feature.insert("dtype".into(), Value::String("error".into()));
            feature.insert("quality".into(), Value::String("BAD".into()));
            feature.insert("error".into(), Value::String("NO_VALUE".into()));
        }
        Some(v) => {
            let dtype = infer_ml_dtype(&v);
            feature.insert("value".into(), v);
            feature.insert("dtype".into(), Value::String(dtype.into()));
            feature.insert("quality".into(), Value::String("GOOD".into()));
        }
    }

    attach_ml_enrichment(&mut feature, msg);
    Value::Object(feature)
}

fn infer_ml_dtype(value: &Value) -> &'static str {
    match value {
        Value::Bool(_) => "bool",
        Value::Number(n) => {
            if n.is_i64() || n.is_u64() { "int" } else { "float" }
        }
        _ => "string",
    }
}

fn attach_ml_enrichment(feature: &mut Map<String, Value>, msg: &Value) {
    let anomaly = read_anomaly_fields(msg);
    let unit = read_normalized_unit(msg);
    let quality = read_quality_fields(msg);
    apply_enrichment_fields(feature, &unit, &quality, &anomaly);
    if let Some(pid) = msg
        .get("pointIdentity")
        .and_then(|pi| pi.get("provisionalPointId"))
        .and_then(Value::as_str)
    {
        feature.insert("provisionalPointId".into(), Value::String(pid.into()));
    }
}

// ── Phase 4: Envelope builders ───────────────────────────────────────────────

fn build_tags_envelope(config: &BatchConfig, tags: Vec<Value>) -> Value {
    let mut envelope = Map::new();
    envelope.insert("timestamp".into(), Value::Number(serde_json::Number::from_f64(config.timestamp_ms).unwrap_or_else(|| (config.timestamp_ms as i64).into())));
    envelope.insert("node".into(), Value::String(config.external_node_name.clone()));
    envelope.insert("group".into(), Value::String(config.external_group_name.clone()));
    envelope.insert("tags".into(), Value::Array(tags));
    if let Some(ref ctx) = config.context {
        envelope.insert("context".into(), ctx.clone());
    }
    Value::Object(envelope)
}

fn build_custom_envelope(config: &BatchConfig, messages: Vec<Value>) -> Value {
    let mut envelope = Map::new();
    envelope.insert(
        "timestamp".into(),
        Value::String(config.timestamp_iso.clone().unwrap_or_default()),
    );
    envelope.insert(
        "protocol".into(),
        Value::String(config.protocol.clone().unwrap_or_default()),
    );
    envelope.insert("messages".into(), Value::Array(messages));
    envelope.insert(
        "msgId".into(),
        Value::String(config.msg_id.clone().unwrap_or_default()),
    );
    if let Some(ref ctx) = config.context {
        envelope.insert("context".into(), ctx.clone());
    }
    Value::Object(envelope)
}

fn build_ml_envelope(config: &BatchConfig, features: Vec<Value>) -> Value {
    let mut envelope = Map::new();
    envelope.insert("timestamp".into(), Value::Number(serde_json::Number::from_f64(config.timestamp_ms).unwrap_or_else(|| (config.timestamp_ms as i64).into())));
    envelope.insert("node".into(), Value::String(config.external_node_name.clone()));
    envelope.insert("group".into(), Value::String(config.external_group_name.clone()));
    envelope.insert(
        "schema".into(),
        Value::String(config.ml_schema.clone().unwrap_or_else(|| "iotistica.ml.v1".into())),
    );
    envelope.insert("features".into(), Value::Array(features));
    if let Some(ref ds) = config.dataset {
        envelope.insert("dataset".into(), dataset_to_value(ds));
    }
    if let Some(ref ctx) = config.context {
        envelope.insert("context".into(), ctx.clone());
    }
    Value::Object(envelope)
}

fn dataset_to_value(ds: &DatasetConfig) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), Value::String(ds.id.clone()));
    m.insert("name".into(), Value::String(ds.name.clone()));
    if let Some(ws) = ds.window_secs {
        if let Some(n) = serde_json::Number::from_f64(ws) {
            m.insert("windowSecs".into(), Value::Number(n));
        }
    }
    if let Some(ref mv) = ds.missing_values {
        m.insert("missingValues".into(), Value::String(mv.clone()));
    }
    if let Some(ref norm) = ds.normalization {
        m.insert("normalization".into(), Value::String(norm.clone()));
    }
    if let Some(ebq) = ds.exclude_bad_quality {
        m.insert("excludeBadQuality".into(), Value::Bool(ebq));
    }
    if let Some(ro) = ds.remove_outliers {
        m.insert("removeOutliers".into(), Value::Bool(ro));
    }
    if let Some(ref om) = ds.outlier_method {
        m.insert("outlierMethod".into(), Value::String(om.clone()));
    }
    if let Some(ref of_) = ds.output_format {
        m.insert("outputFormat".into(), Value::String(of_.clone()));
    }
    Value::Object(m)
}
