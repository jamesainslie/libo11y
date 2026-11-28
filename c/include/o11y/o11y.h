/*
 * libo11y for C11: traces, metrics and logs over OpenTelemetry.
 *
 * Copyright 2026 libo11y contributors.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Conventions
 *
 * Errors. A function that can fail returns o11y_err_t and writes its result
 * through an out-parameter, which it sets to NULL or zero on failure. The
 * functions on the hot path (logging, spans, measurements, propagation)
 * return void or a handle and never fail the host. Given a NULL handle they
 * do nothing.
 *
 * Ownership. A handle belongs to the caller, who releases it with the
 * function its declaration names: o11y_destroy for an SDK, o11y_ctx_destroy
 * for a context, o11y_span_end for a span, and so on. A function that hands
 * back a `char *` through an out-parameter allocates it, and the caller
 * frees it with o11y_string_free. A `const char *` return value is borrowed,
 * and its declaration says how long it stays valid. libo11y copies what it
 * keeps from every argument before the call returns, with two exceptions:
 * the callbacks and userdata pointers in o11y_options_t, which must stay
 * valid until o11y_destroy, and the callback and userdata of an observable
 * instrument, which must stay valid until the SDK is destroyed.
 *
 * Threads. Every function may be called from any thread. An SDK, its
 * tracers and meters, instruments, contexts, records and detached carriers
 * may be used from several threads at once. A span may be modified from
 * several threads at once, but o11y_span_end frees the handle, so no other
 * call on that span may run during or after it. The same holds for every
 * destroy function. Callbacks run on the thread that triggers them, which
 * for exporter errors and observable instruments is a libo11y thread.
 *
 * Signals. Hermetic handles (O11Y_ENV_HERMETIC SDKs, o11y_record_create, and
 * o11y_test_start) never install or alter POSIX signal handlers. While at
 * least one non-hermetic handle (networked SDK or test OTLP receiver) is live,
 * libo11y keeps an internal I/O thread pool. If the host left SIGIO at SIG_DFL
 * (or SIGPIPE at SIG_DFL on non-Linux POSIX targets), libo11y installs an
 * internal no-op handler and restores the prior disposition only if still
 * unchanged when the last networked handle is destroyed. Host handlers already
 * installed or changed while live are preserved.
 *
 * Slices. Fallible (o11y_err_t) functions reject a non-zero length paired with
 * a NULL pointer with O11Y_ERR_INVALID_ARGUMENT. Hot-path void or handle
 * functions (attributes, links, histogram buckets, o11y_redact_mask) treat a
 * NULL pointer as empty.
 */

#ifndef O11Y_H
#define O11Y_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "o11y/spec.h"

#ifdef __cplusplus
extern "C" {
#endif

/* =========================================================================
 * Version & error codes
 * ========================================================================= */

/** The version of these headers. o11y_version() reports the library's. */
#define O11Y_VERSION_MAJOR 0
#define O11Y_VERSION_MINOR 2
#define O11Y_VERSION_PATCH 0
#define O11Y_VERSION "0.2.0"

/** Returns the semantic version of the linked library, such as "0.2.0". */
const char *o11y_version(void);

/** Typed error codes returned by fallible libo11y C API calls. */
typedef enum o11y_err {
    O11Y_OK = 0,
    O11Y_ERR_ALREADY_SETUP = 1,
    O11Y_ERR_NO_SERVICE_NAME = 2,
    O11Y_ERR_NO_ENVIRONMENT = 3,
    O11Y_ERR_INVALID_ENVIRONMENT = 4,
    O11Y_ERR_PII_HASH_KEY = 5,
    O11Y_ERR_INVALID_APP_REGISTRY = 6,
    O11Y_ERR_CANARY_REJECTED = 7,
    O11Y_ERR_UNSUPPORTED_PROTOCOL = 8,
    O11Y_ERR_EXPORTER = 9,
    O11Y_ERR_OUT_OF_MEMORY = 10,
    O11Y_ERR_INVALID_ARGUMENT = 11,
    O11Y_ERR_INVALID_CARRIER = 12,
    O11Y_ERR_TIMEOUT = 13,
    O11Y_ERR_SHUTDOWN = 14,
    O11Y_ERR_IO = 15,
    O11Y_ERR_UNSUPPORTED_PROPAGATOR = 16
} o11y_err_t;

/** Returns the name of err as a static string, such as "O11Y_ERR_TIMEOUT". Never NULL. */
const char *o11y_err_name(o11y_err_t err);

/**
 * Receives the reason o11y_setup, o11y_init or o11y_test_start failed, as
 * NUL-terminated text of len bytes. Those functions clear it first, so it is
 * empty after a success. A message longer than the buffer is truncated.
 */
typedef struct o11y_diagnostic {
    char message[1024];
    size_t len;
} o11y_diagnostic_t;

/** Frees a string libo11y returned through a `char **` out-parameter. NULL is accepted. */
void o11y_string_free(char *s);

/* =========================================================================
 * Opaque handles
 * ========================================================================= */

typedef struct o11y_sdk o11y_sdk_t;
typedef struct o11y_ctx o11y_ctx_t;
typedef struct o11y_tracer o11y_tracer_t;
typedef struct o11y_span o11y_span_t;
typedef struct o11y_meter o11y_meter_t;
typedef struct o11y_record o11y_record_t;
typedef struct o11y_detached_carrier o11y_detached_carrier_t;
typedef struct o11y_linked_span o11y_linked_span_t;

/* =========================================================================
 * Trace & Span IDs
 * ========================================================================= */

typedef struct o11y_trace_id {
    uint8_t bytes[16];
} o11y_trace_id_t;

typedef struct o11y_span_id {
    uint8_t bytes[8];
} o11y_span_id_t;

typedef struct o11y_span_context {
    o11y_trace_id_t trace_id;
    o11y_span_id_t span_id;
    uint8_t trace_flags;
    bool remote;
    /**
     * The W3C tracestate header, or NULL when it is empty. In a value libo11y
     * returns, the text belongs to the handle it was read from and stays
     * valid until that handle is ended or destroyed.
     */
    const char *trace_state;
} o11y_span_context_t;

bool o11y_trace_id_is_valid(o11y_trace_id_t id);
bool o11y_span_id_is_valid(o11y_span_id_t id);
bool o11y_span_context_is_valid(o11y_span_context_t sc);
bool o11y_span_context_is_sampled(o11y_span_context_t sc);
/** Writes 32 lowercase hex chars + NUL to out (NULL is ignored). */
void o11y_trace_id_hex(o11y_trace_id_t id, char out[33]);
/** Writes 16 lowercase hex chars + NUL to out (NULL is ignored). */
void o11y_span_id_hex(o11y_span_id_t id, char out[17]);
bool o11y_trace_id_parse_hex(const char *hex, o11y_trace_id_t *out);
bool o11y_span_id_parse_hex(const char *hex, o11y_span_id_t *out);

/* =========================================================================
 * Attributes (spans, metrics, resources)
 * ========================================================================= */

typedef enum o11y_attr_kind {
    O11Y_ATTR_STRING = 0,
    O11Y_ATTR_BOOL = 1,
    O11Y_ATTR_INT = 2,
    O11Y_ATTR_DOUBLE = 3,
    O11Y_ATTR_STRING_ARRAY = 4,
    O11Y_ATTR_BOOL_ARRAY = 5,
    O11Y_ATTR_INT_ARRAY = 6,
    O11Y_ATTR_DOUBLE_ARRAY = 7
} o11y_attr_kind_t;

typedef struct o11y_attr {
    const char *key;
    o11y_attr_kind_t kind;
    union {
        const char *str_val;
        bool bool_val;
        int64_t int_val;
        double double_val;
        struct {
            const char *const *items;
            size_t len;
        } str_array;
        struct {
            const bool *items;
            size_t len;
        } bool_array;
        struct {
            const int64_t *items;
            size_t len;
        } int_array;
        struct {
            const double *items;
            size_t len;
        } double_array;
    } value;
} o11y_attr_t;

static inline o11y_attr_t o11y_kv_str(const char *key, const char *val) {
    o11y_attr_t a;
    a.key = key;
    a.kind = O11Y_ATTR_STRING;
    a.value.str_val = val;
    return a;
}

static inline o11y_attr_t o11y_kv_bool(const char *key, bool val) {
    o11y_attr_t a;
    a.key = key;
    a.kind = O11Y_ATTR_BOOL;
    a.value.bool_val = val;
    return a;
}

static inline o11y_attr_t o11y_kv_int(const char *key, int64_t val) {
    o11y_attr_t a;
    a.key = key;
    a.kind = O11Y_ATTR_INT;
    a.value.int_val = val;
    return a;
}

static inline o11y_attr_t o11y_kv_double(const char *key, double val) {
    o11y_attr_t a;
    a.key = key;
    a.kind = O11Y_ATTR_DOUBLE;
    a.value.double_val = val;
    return a;
}

static inline o11y_attr_t o11y_kv_str_array(const char *key, const char *const *items, size_t len) {
    o11y_attr_t a;
    a.key = key;
    a.kind = O11Y_ATTR_STRING_ARRAY;
    a.value.str_array.items = items;
    a.value.str_array.len = len;
    return a;
}

static inline o11y_attr_t o11y_kv_bool_array(const char *key, const bool *items, size_t len) {
    o11y_attr_t a;
    a.key = key;
    a.kind = O11Y_ATTR_BOOL_ARRAY;
    a.value.bool_array.items = items;
    a.value.bool_array.len = len;
    return a;
}

static inline o11y_attr_t o11y_kv_int_array(const char *key, const int64_t *items, size_t len) {
    o11y_attr_t a;
    a.key = key;
    a.kind = O11Y_ATTR_INT_ARRAY;
    a.value.int_array.items = items;
    a.value.int_array.len = len;
    return a;
}

static inline o11y_attr_t o11y_kv_double_array(const char *key, const double *items, size_t len) {
    o11y_attr_t a;
    a.key = key;
    a.kind = O11Y_ATTR_DOUBLE_ARRAY;
    a.value.double_array.items = items;
    a.value.double_array.len = len;
    return a;
}

/* =========================================================================
 * Structured log values & attributes (supports nested arrays, maps, bytes)
 * ========================================================================= */

typedef enum o11y_log_value_kind {
    O11Y_LOG_VAL_EMPTY = 0,
    O11Y_LOG_VAL_STRING = 1,
    O11Y_LOG_VAL_BOOL = 2,
    O11Y_LOG_VAL_INT = 3,
    O11Y_LOG_VAL_DOUBLE = 4,
    O11Y_LOG_VAL_BYTES = 5,
    O11Y_LOG_VAL_ARRAY = 6,
    O11Y_LOG_VAL_MAP = 7
} o11y_log_value_kind_t;

typedef struct o11y_log_attr o11y_log_attr_t;

typedef struct o11y_log_value {
    o11y_log_value_kind_t kind;
    union {
        struct {
            const char *data;
            size_t len;
            bool has_len; /* if false, data is NUL-terminated */
        } str_val;
        bool bool_val;
        int64_t int_val;
        double double_val;
        struct {
            const uint8_t *data;
            size_t len;
        } bytes_val;
        struct {
            const struct o11y_log_value *items;
            size_t len;
        } array_val;
        struct {
            const o11y_log_attr_t *items;
            size_t len;
        } map_val;
    } value;
} o11y_log_value_t;

struct o11y_log_attr {
    const char *key;
    o11y_log_value_t value;
};

static inline o11y_log_value_t o11y_log_val_empty(void) {
    o11y_log_value_t v;
    v.kind = O11Y_LOG_VAL_EMPTY;
    v.value.int_val = 0;
    return v;
}

static inline o11y_log_value_t o11y_log_val_str(const char *s) {
    o11y_log_value_t v;
    v.kind = O11Y_LOG_VAL_STRING;
    v.value.str_val.data = s;
    v.value.str_val.len = 0;
    v.value.str_val.has_len = false;
    return v;
}

static inline o11y_log_value_t o11y_log_val_strn(const char *s, size_t len) {
    o11y_log_value_t v;
    v.kind = O11Y_LOG_VAL_STRING;
    v.value.str_val.data = s;
    v.value.str_val.len = len;
    v.value.str_val.has_len = true;
    return v;
}

static inline o11y_log_value_t o11y_log_val_bool(bool b) {
    o11y_log_value_t v;
    v.kind = O11Y_LOG_VAL_BOOL;
    v.value.bool_val = b;
    return v;
}

static inline o11y_log_value_t o11y_log_val_int(int64_t n) {
    o11y_log_value_t v;
    v.kind = O11Y_LOG_VAL_INT;
    v.value.int_val = n;
    return v;
}

static inline o11y_log_value_t o11y_log_val_double(double d) {
    o11y_log_value_t v;
    v.kind = O11Y_LOG_VAL_DOUBLE;
    v.value.double_val = d;
    return v;
}

static inline o11y_log_value_t o11y_log_val_bytes(const uint8_t *data, size_t len) {
    o11y_log_value_t v;
    v.kind = O11Y_LOG_VAL_BYTES;
    v.value.bytes_val.data = data;
    v.value.bytes_val.len = len;
    return v;
}

static inline o11y_log_value_t o11y_log_val_array(const o11y_log_value_t *items, size_t len) {
    o11y_log_value_t v;
    v.kind = O11Y_LOG_VAL_ARRAY;
    v.value.array_val.items = items;
    v.value.array_val.len = len;
    return v;
}

static inline o11y_log_value_t o11y_log_val_map(const o11y_log_attr_t *items, size_t len) {
    o11y_log_value_t v;
    v.kind = O11Y_LOG_VAL_MAP;
    v.value.map_val.items = items;
    v.value.map_val.len = len;
    return v;
}

static inline o11y_log_attr_t o11y_log_kv_str(const char *key, const char *val) {
    o11y_log_attr_t a;
    a.key = key;
    a.value = o11y_log_val_str(val);
    return a;
}

static inline o11y_log_attr_t o11y_log_kv_bool(const char *key, bool val) {
    o11y_log_attr_t a;
    a.key = key;
    a.value = o11y_log_val_bool(val);
    return a;
}

static inline o11y_log_attr_t o11y_log_kv_int(const char *key, int64_t val) {
    o11y_log_attr_t a;
    a.key = key;
    a.value = o11y_log_val_int(val);
    return a;
}

static inline o11y_log_attr_t o11y_log_kv_double(const char *key, double val) {
    o11y_log_attr_t a;
    a.key = key;
    a.value = o11y_log_val_double(val);
    return a;
}

static inline o11y_log_attr_t o11y_log_kv_bytes(const char *key, const uint8_t *data, size_t len) {
    o11y_log_attr_t a;
    a.key = key;
    a.value = o11y_log_val_bytes(data, len);
    return a;
}

static inline o11y_log_attr_t o11y_log_kv_array(const char *key, const o11y_log_value_t *items, size_t len) {
    o11y_log_attr_t a;
    a.key = key;
    a.value = o11y_log_val_array(items, len);
    return a;
}

static inline o11y_log_attr_t o11y_log_kv_map(const char *key, const o11y_log_attr_t *items, size_t len) {
    o11y_log_attr_t a;
    a.key = key;
    a.value = o11y_log_val_map(items, len);
    return a;
}

/* =========================================================================
 * Capture-time redaction helpers
 * ========================================================================= */

/** Returns the literal "REDACTED" for capture-time secret protection. */
const char *o11y_redact_secret(void);

/**
 * Masks value into out as one 'X' for each UTF-8 code point of value, and
 * each byte of an invalid sequence counts as one code point. It writes at
 * most out_cap - 1 characters and a NUL terminator, and nothing when out is
 * NULL or out_cap is 0. Returns the code point count of value, which is the
 * length an untruncated mask has.
 */
size_t o11y_redact_mask(const char *value, size_t value_len, char *out, size_t out_cap);

/** Returns a log attribute whose value is the literal "REDACTED". */
static inline o11y_log_attr_t o11y_log_kv_secret(const char *key) {
    return o11y_log_kv_str(key, "REDACTED");
}

/**
 * Returns a log attribute whose value is value masked into buf, one 'X' for
 * each UTF-8 code point. buf must stay valid until the attribute is logged.
 * A value longer than buf_cap - 1 code points is truncated.
 */
static inline o11y_log_attr_t o11y_log_kv_masked(const char *key, const char *value, char *buf, size_t buf_cap) {
    (void)o11y_redact_mask(value, value != NULL ? strlen(value) : 0, buf, buf_cap);
    return o11y_log_kv_str(key, buf_cap > 0 ? buf : "");
}

/* =========================================================================
 * Configuration & lifecycle
 * ========================================================================= */

typedef enum o11y_env_mode {
    /**
     * Read standard OTEL_* variables from the process environment during setup.
     * Only OTEL_* variables are inspected and copied transiently. The host must
     * not concurrently mutate process environ while o11y_setup/o11y_init runs.
     */
    O11Y_ENV_PROCESS = 0,
    /** Hermetic mode: ignore all OTEL_* variables; disable un-injected signals. */
    O11Y_ENV_HERMETIC = 1,
    /** Read variables from options.env_pairs. */
    O11Y_ENV_PAIRS = 2,
    /** Read "KEY=VALUE" entries from options.env_entries. */
    O11Y_ENV_ENTRIES = 3
} o11y_env_mode_t;

typedef struct o11y_env_pair {
    const char *key;
    const char *value;
} o11y_env_pair_t;

typedef enum o11y_protocol {
    /** Use OTEL_EXPORTER_OTLP_*_PROTOCOL or default http/protobuf. */
    O11Y_PROTOCOL_DEFAULT = 0,
    O11Y_PROTOCOL_HTTP_PROTOBUF = 1,
    O11Y_PROTOCOL_HTTP_JSON = 2,
    O11Y_PROTOCOL_GRPC = 3
} o11y_protocol_t;

typedef enum o11y_level {
    O11Y_LEVEL_DEBUG = 0,
    O11Y_LEVEL_INFO = 1,
    O11Y_LEVEL_WARN = 2,
    O11Y_LEVEL_ERROR = 3
} o11y_level_t;

typedef enum o11y_console_format {
    O11Y_CONSOLE_JSON = 0,
    O11Y_CONSOLE_TEXT = 1
} o11y_console_format_t;

typedef enum o11y_console_target {
    O11Y_CONSOLE_STDOUT = 0,
    O11Y_CONSOLE_STDERR = 1,
    O11Y_CONSOLE_CUSTOM = 2
} o11y_console_target_t;

/**
 * Custom console write callback. Return O11Y_OK on success or error to reject.
 * Runs under an internal console lock, so it must not log back to the same SDK.
 */
typedef o11y_err_t (*o11y_console_write_fn)(void *userdata, const uint8_t *bytes, size_t len);

typedef enum o11y_pii_mode {
    O11Y_PII_DROP = 0,
    O11Y_PII_HASH = 1,
    O11Y_PII_ALLOW = 2
} o11y_pii_mode_t;

typedef enum o11y_sampler_kind {
    /** Use OTEL_TRACES_SAMPLER or default ParentBased(AlwaysOn). */
    O11Y_SAMPLER_DEFAULT = 0,
    O11Y_SAMPLER_ALWAYS_ON = 1,
    O11Y_SAMPLER_ALWAYS_OFF = 2,
    O11Y_SAMPLER_TRACE_ID_RATIO = 3,
    O11Y_SAMPLER_PARENT_BASED_ALWAYS_ON = 4,
    O11Y_SAMPLER_PARENT_BASED_ALWAYS_OFF = 5,
    O11Y_SAMPLER_PARENT_BASED_TRACE_ID_RATIO = 6
} o11y_sampler_kind_t;

typedef enum o11y_exemplar_filter {
    /** Use OTEL_METRICS_EXEMPLAR_FILTER or default trace_based. */
    O11Y_EXEMPLAR_FILTER_DEFAULT = 0,
    O11Y_EXEMPLAR_FILTER_TRACE_BASED = 1,
    O11Y_EXEMPLAR_FILTER_ALWAYS_ON = 2,
    O11Y_EXEMPLAR_FILTER_ALWAYS_OFF = 3
} o11y_exemplar_filter_t;

typedef struct o11y_build_info {
    bool enabled;
    const char *version;
    const char *revision;
    const char *time;
    bool modified_set;
    bool modified;
} o11y_build_info_t;

typedef struct o11y_app_registry_source {
    /** If content != NULL, validates YAML in memory; otherwise reads file_path. */
    const char *file_path;
    const char *content;
    size_t content_len;
} o11y_app_registry_source_t;

typedef struct o11y_histogram_buckets {
    const char *instrument_name;
    const double *boundaries;
    size_t boundaries_len;
} o11y_histogram_buckets_t;

/** Opaque replacement builder passed to o11y_attr_replacer_fn. Valid only during the callback. */
typedef struct o11y_attr_replacement o11y_attr_replacement_t;

/**
 * Sets the replacement attribute key inside o11y_attr_replacer_fn, copying key
 * immediately into pipeline storage before returning. Returns O11Y_OK,
 * O11Y_ERR_INVALID_ARGUMENT on NULL inputs, or O11Y_ERR_OUT_OF_MEMORY.
 */
o11y_err_t o11y_attr_replacement_set_key(o11y_attr_replacement_t *dst, const char *key);

/**
 * Sets the replacement attribute value inside o11y_attr_replacer_fn, deep-copying
 * strings, bytes, arrays, and maps immediately into pipeline storage before
 * returning. Returns O11Y_OK, O11Y_ERR_INVALID_ARGUMENT on NULL, cyclic,
 * over-depth (depth >= 16), over-budget, or emptied composite inputs, or
 * O11Y_ERR_OUT_OF_MEMORY.
 */
o11y_err_t o11y_attr_replacement_set_value(o11y_attr_replacement_t *dst, const o11y_log_value_t *value);

/**
 * Attribute replacer callback invoked once per leaf log attribute before
 * per-leg sensitivity classification.
 *
 * To drop the attribute, return false.
 * To keep unchanged, return true without calling either setter on
 * out_replacement.
 * To rename the key or replace the value, call o11y_attr_replacement_set_key
 * and/or o11y_attr_replacement_set_value with out_replacement before returning
 * true. All data is deep-copied synchronously during the setter call. Setter
 * failures are sticky: if any setter call fails, the attribute is dropped
 * even if a later setter succeeds or the callback returns true.
 */
typedef bool (*o11y_attr_replacer_fn)(
    void *userdata,
    const char *const *groups,
    size_t groups_len,
    const char *key,
    const o11y_log_value_t *value,
    o11y_attr_replacement_t *out_replacement);

/** Extra log sink callbacks (post-classification, correlated). */
typedef struct o11y_log_sink {
    void *userdata;
    bool (*enabled)(void *userdata, o11y_level_t level, bool force_emit);
    o11y_err_t (*emit)(
        void *userdata,
        uint64_t time_unix_nano,
        o11y_level_t level,
        const char *message,
        o11y_span_context_t span_context,
        const o11y_log_attr_t *attrs,
        size_t attrs_len);
} o11y_log_sink_t;

/**
 * A text carrier, such as a set of HTTP headers. libo11y calls get and set
 * during the call the carrier is passed to and never keeps the carrier.
 */
typedef struct o11y_carrier {
    void *userdata;
    /**
     * Returns the NUL-terminated value for key, or NULL when absent.
     * libo11y copies the string before calling get for the next key.
     */
    const char *(*get)(void *userdata, const char *key);
    /** Stores value for key. Both strings are valid only during the call. */
    void (*set)(void *userdata, const char *key, const char *value);
} o11y_carrier_t;

typedef enum o11y_propagator_kind {
    /** W3C Trace Context: the traceparent and tracestate headers. */
    O11Y_PROPAGATOR_TRACE_CONTEXT = 0,
    /** W3C Baggage: the baggage header. */
    O11Y_PROPAGATOR_BAGGAGE = 1,
    /** The inject and extract callbacks of the o11y_propagator_t. */
    O11Y_PROPAGATOR_CUSTOM = 2
} o11y_propagator_kind_t;

/**
 * One propagator in o11y_options_t.propagators. Only kind is read unless it
 * is O11Y_PROPAGATOR_CUSTOM. A custom propagator sets inject, extract or
 * both.
 */
typedef struct o11y_propagator {
    o11y_propagator_kind_t kind;
    void *userdata;
    /** Writes what ctx carries into carrier. ctx is valid only during the call. */
    void (*inject)(void *userdata, const o11y_ctx_t *ctx, const o11y_carrier_t *carrier);
    /**
     * Reads carrier and returns a new context derived from parent, for
     * example with o11y_ctx_with_span_context, or NULL when the carrier
     * holds nothing. libo11y destroys the context it returns. parent is
     * valid only during the call.
     */
    o11y_ctx_t *(*extract)(void *userdata, const o11y_ctx_t *parent, const o11y_carrier_t *carrier);
    /** The carrier keys inject sets. */
    const char *const *fields;
    size_t fields_len;
} o11y_propagator_t;

/** Reports whether the baggage member named key may leave the process. */
typedef bool (*o11y_baggage_egress_allow_fn)(void *userdata, const char *key);
/** Receives one export failure as NUL-terminated text, valid only during the call. */
typedef void (*o11y_error_handler_fn)(void *userdata, const char *message);

typedef struct o11y_options {
    /**
     * Must be sizeof(o11y_options_t), initialized by o11y_options_default().
     * Zero-initialized or mismatched structs are rejected with O11Y_ERR_INVALID_ARGUMENT.
     */
    size_t struct_size;

    o11y_env_mode_t env_mode;
    const o11y_env_pair_t *env_pairs;
    size_t env_pairs_len;
    const char *const *env_entries;
    size_t env_entries_len;

    o11y_protocol_t protocol;

    const char *service_name;
    const char *service_version;
    const char *service_namespace;
    const char *environment;
    const char *const *extra_environments;
    size_t extra_environments_len;
    bool strict_identity;

    const o11y_attr_t *resource_attributes;
    size_t resource_attributes_len;

    o11y_build_info_t build_info;

    o11y_level_t log_level;
    bool console_enabled;
    o11y_console_format_t console_format;
    o11y_console_target_t console_target;
    o11y_console_write_fn console_write_fn;
    void *console_write_userdata;
    bool log_export;

    o11y_attr_replacer_fn attr_replacer_fn;
    void *attr_replacer_userdata;
    const o11y_log_sink_t *extra_log_sinks;
    size_t extra_log_sinks_len;

    o11y_pii_mode_t pii_mode;
    const uint8_t *pii_hash_key;
    size_t pii_hash_key_len;

    const o11y_app_registry_source_t *app_registries;
    size_t app_registries_len;

    o11y_sampler_kind_t sampler_kind;
    double sampler_ratio;

    /**
     * Replaces the default propagators, W3C Trace Context and Baggage, when
     * propagators_len is not 0. To add a legacy format, list the two W3C
     * kinds beside the custom propagator.
     */
    const o11y_propagator_t *propagators;
    size_t propagators_len;
    /**
     * Filters the baggage that inject writes, whatever the propagators are.
     * NULL allows every key. Extraction is never filtered.
     */
    o11y_baggage_egress_allow_fn baggage_egress_allow;
    void *baggage_egress_allow_userdata;

    const o11y_histogram_buckets_t *histogram_buckets;
    size_t histogram_buckets_len;
    o11y_exemplar_filter_t exemplar_filter;

    bool runtime_metrics;
    bool startup_summary;

    o11y_error_handler_fn error_handler_fn;
    void *error_handler_userdata;
} o11y_options_t;

/**
 * Returns the default options. Always start from this value: several
 * defaults are not zero (struct_size = sizeof(o11y_options_t),
 * strict_identity = true, log_level = O11Y_LEVEL_INFO, console_enabled = true,
 * log_export = true, sampler_ratio = 1.0, runtime_metrics = true,
 * startup_summary = true). Zero-initialized structs and enum fields outside the
 * values defined in this header fail setup with O11Y_ERR_INVALID_ARGUMENT.
 */
o11y_options_t o11y_options_default(void);

typedef struct o11y_shutdown_report {
    o11y_err_t logs;
    o11y_err_t metrics;
    o11y_err_t traces;
} o11y_shutdown_report_t;

static inline bool o11y_shutdown_report_ok(o11y_shutdown_report_t r) {
    return r.logs == O11Y_OK && r.metrics == O11Y_OK && r.traces == O11Y_OK;
}

/**
 * Builds an SDK, emits the o11y.telemetry.configured startup canary, and
 * takes the process-wide setup guard, which o11y_shutdown or o11y_destroy
 * releases.
 *
 * On success it stores the SDK in *out_sdk, and the caller releases it with
 * o11y_destroy. On failure it sets *out_sdk to NULL, writes the reason to
 * diag when diag is not NULL, and returns the error, which is
 * O11Y_ERR_ALREADY_SETUP while another o11y_setup SDK is active. A NULL
 * options pointer means the defaults. It never aborts or exits the process.
 */
o11y_err_t o11y_setup(
    const o11y_options_t *options,
    o11y_sdk_t **out_sdk,
    o11y_diagnostic_t *diag);

/**
 * Builds an independent SDK without the setup guard and without the startup
 * canary, for tests and for several SDKs in one process. Its arguments and
 * results are those of o11y_setup.
 */
o11y_err_t o11y_init(
    const o11y_options_t *options,
    o11y_sdk_t **out_sdk,
    o11y_diagnostic_t *diag);

/**
 * Shuts down logs, metrics, and traces concurrently under one shared timeout
 * (0 uses the 5000 ms default). Idempotent: concurrent and later callers wait
 * and receive the same per-signal report. Accepts NULL sdk (zeroes out_report
 * and returns O11Y_OK).
 */
o11y_err_t o11y_shutdown(
    o11y_sdk_t *sdk,
    uint64_t timeout_ms,
    o11y_shutdown_report_t *out_report);

/**
 * Flushes logs, metrics, and traces sequentially under one shared timeout
 * (0 uses the 5000 ms default). Accepts NULL sdk (zeroes out_report and
 * returns O11Y_OK).
 */
o11y_err_t o11y_force_flush(
    o11y_sdk_t *sdk,
    uint64_t timeout_ms,
    o11y_shutdown_report_t *out_report);

/**
 * Shuts the SDK down if o11y_shutdown has not run, then frees it and every
 * tracer, meter and instrument obtained from it. Spans, contexts, records
 * and carriers are separate handles: end or destroy them first. NULL is
 * accepted.
 */
void o11y_destroy(o11y_sdk_t *sdk);

/**
 * Returns the effective configuration as one line of key=value pairs. The
 * string belongs to the SDK and stays valid until o11y_destroy. Returns ""
 * for a NULL SDK.
 */
const char *o11y_effective_config(const o11y_sdk_t *sdk);

/** Signal-driven graceful shutdown options. */
typedef struct o11y_signal_options {
    /** Total shared budget in milliseconds (0 = 5000 ms default). */
    uint64_t timeout_ms;
    /** Optional hook invoked after signal receipt and before telemetry shutdown. */
    void (*before_shutdown)(void *userdata);
    void *before_shutdown_userdata;
    /**
     * POSIX signal numbers, at most 16. signals_len 0 means SIGINT and
     * SIGTERM.
     */
    const int *signals;
    size_t signals_len;
} o11y_signal_options_t;

/**
 * Installs signal handlers, blocks until a signal arrives, restores SIG_DFL,
 * invokes before_shutdown, and shuts down sdk under one shared deadline.
 * Zeroes out_report on entry. Returns O11Y_ERR_INVALID_ARGUMENT, without
 * waiting, for a NULL sdk, more than 16 signals, non-catchable signals
 * (SIGKILL, SIGSTOP), or OS-invalid signal numbers.
 */
o11y_err_t o11y_shutdown_on_signals(
    o11y_sdk_t *sdk,
    const o11y_signal_options_t *options,
    o11y_shutdown_report_t *out_report);

/* =========================================================================
 * Context
 * ========================================================================= */

/*
 * A context is immutable. Each function below that returns an o11y_ctx_t *
 * allocates a new context, which the caller releases with o11y_ctx_destroy,
 * and returns NULL when memory runs out. A context copies the span context
 * and the baggage it carries, so it stays valid after the parent context is
 * destroyed and after the span it was derived from ends. It borrows only the
 * record of o11y_ctx_with_record, which must outlive it. NULL is accepted
 * wherever a `const o11y_ctx_t *` is, and means the background context.
 */

/** Creates an empty context. */
o11y_ctx_t *o11y_ctx_create(void);
/** Frees a context. NULL is accepted. */
void o11y_ctx_destroy(o11y_ctx_t *ctx);

/** Derives a context whose current span is span. */
o11y_ctx_t *o11y_ctx_with_span(const o11y_ctx_t *parent, o11y_span_t *span);
/** Derives a context whose current span is the remote span sc. */
o11y_ctx_t *o11y_ctx_with_span_context(const o11y_ctx_t *parent, o11y_span_context_t sc);
/** Derives a context whose log records bypass level gates, for audit records. */
o11y_ctx_t *o11y_ctx_with_force_emit(const o11y_ctx_t *parent);
/** Derives a context that accumulates into the wide-event record. */
o11y_ctx_t *o11y_ctx_with_record(const o11y_ctx_t *parent, o11y_record_t *record);
/**
 * Derives a context with the baggage member key set to value, replacing a
 * member of the same name. Enforces W3C token validation on key, UTF-8
 * validation on key and value, and W3C limits (64 members, 8192 bytes).
 * An invalid or NULL/empty key returns a copy of parent.
 */
o11y_ctx_t *o11y_ctx_with_baggage_item(const o11y_ctx_t *parent, const char *key, const char *value);

/** Returns the current span context of ctx, which is invalid when it has none. */
o11y_span_context_t o11y_ctx_span_context(const o11y_ctx_t *ctx);
/**
 * Returns the baggage value for key, or NULL when ctx has no such member.
 * The string belongs to ctx and stays valid until o11y_ctx_destroy.
 */
const char *o11y_ctx_baggage_get(const o11y_ctx_t *ctx, const char *key);
/** Returns the wide-event record of ctx, or NULL. The record is not owned by ctx. */
o11y_record_t *o11y_ctx_record(const o11y_ctx_t *ctx);

/* =========================================================================
 * Tracing
 * ========================================================================= */

typedef enum o11y_span_kind {
    O11Y_SPAN_KIND_INTERNAL = 1,
    O11Y_SPAN_KIND_SERVER = 2,
    O11Y_SPAN_KIND_CLIENT = 3,
    O11Y_SPAN_KIND_PRODUCER = 4,
    O11Y_SPAN_KIND_CONSUMER = 5
} o11y_span_kind_t;

typedef enum o11y_status_code {
    O11Y_STATUS_UNSET = 0,
    O11Y_STATUS_ERROR = 1,
    O11Y_STATUS_OK = 2
} o11y_status_code_t;

typedef struct o11y_span_link {
    o11y_span_context_t span_context;
    const o11y_attr_t *attributes;
    size_t attributes_len;
} o11y_span_link_t;

typedef struct o11y_span_start_options {
    o11y_span_kind_t kind; /* 0 defaults to O11Y_SPAN_KIND_INTERNAL */
    const o11y_attr_t *attributes;
    size_t attributes_len;
    const o11y_span_link_t *links;
    size_t links_len;
    /** Unix nanoseconds; 0 uses current wall clock time. */
    uint64_t start_time_unix_nano;
    /** Ignore parent span in ctx and start a new root trace. */
    bool new_root;
} o11y_span_start_options_t;

/**
 * Returns the tracer for the instrumentation scope name. It belongs to sdk
 * and stays valid until o11y_destroy. A NULL sdk gives a tracer whose spans
 * record nothing.
 */
o11y_tracer_t *o11y_tracer(o11y_sdk_t *sdk, const char *name);
o11y_tracer_t *o11y_tracer_with_scope(
    o11y_sdk_t *sdk,
    const char *name,
    const char *version,
    const char *schema_url);

/**
 * Starts a span as a child of the current span of ctx, or as a root span.
 * The caller ends it with o11y_span_end, which frees the handle. Returns
 * NULL when memory runs out, and every span function accepts NULL.
 */
o11y_span_t *o11y_tracer_start(
    o11y_tracer_t *tracer,
    const o11y_ctx_t *ctx,
    const char *name,
    const o11y_span_start_options_t *options);

/** Returns the span's context. Its trace_state stays valid until the span ends. */
o11y_span_context_t o11y_span_context(const o11y_span_t *span);
bool o11y_span_is_recording(const o11y_span_t *span);
void o11y_span_set_name(o11y_span_t *span, const char *name);
void o11y_span_set_attrs(o11y_span_t *span, const o11y_attr_t *attrs, size_t attrs_len);
void o11y_span_set_attr(o11y_span_t *span, o11y_attr_t attr);
void o11y_span_set_status(o11y_span_t *span, o11y_status_code_t code, const char *description);
void o11y_span_add_event(
    o11y_span_t *span,
    const char *name,
    const o11y_attr_t *attrs,
    size_t attrs_len,
    uint64_t timestamp_unix_nano);
void o11y_span_record_error(
    o11y_span_t *span,
    const char *error_type,
    const char *message,
    const o11y_attr_t *attrs,
    size_t attrs_len);
void o11y_span_add_link(o11y_span_t *span, const o11y_span_link_t *link);

/** Ends the span and frees the handle (NULL-safe). */
void o11y_span_end(o11y_span_t *span);
/** Ends the span with an explicit Unix nanosecond timestamp and frees the handle. */
void o11y_span_end_at(o11y_span_t *span, uint64_t end_time_unix_nano);

/* =========================================================================
 * Metrics & Exemplars
 * ========================================================================= */

typedef struct o11y_instrument_options {
    const char *description;
    const char *unit;
} o11y_instrument_options_t;

typedef struct o11y_histogram_options {
    const char *description;
    const char *unit;
    const double *explicit_bucket_boundaries;
    size_t explicit_bucket_boundaries_len;
} o11y_histogram_options_t;

typedef struct o11y_counter_i64 { void *impl; } o11y_counter_i64_t;
typedef struct o11y_counter_f64 { void *impl; } o11y_counter_f64_t;
typedef struct o11y_updown_i64 { void *impl; } o11y_updown_i64_t;
typedef struct o11y_updown_f64 { void *impl; } o11y_updown_f64_t;
typedef struct o11y_histogram_i64 { void *impl; } o11y_histogram_i64_t;
typedef struct o11y_histogram_f64 { void *impl; } o11y_histogram_f64_t;
typedef struct o11y_gauge_i64 { void *impl; } o11y_gauge_i64_t;
typedef struct o11y_gauge_f64 { void *impl; } o11y_gauge_f64_t;

typedef struct o11y_observation_i64 o11y_observation_i64_t;
typedef struct o11y_observation_f64 o11y_observation_f64_t;

typedef void (*o11y_observe_i64_fn)(void *userdata, o11y_observation_i64_t *obs);
typedef void (*o11y_observe_f64_fn)(void *userdata, o11y_observation_f64_t *obs);

void o11y_observation_i64_observe(
    o11y_observation_i64_t *obs,
    int64_t value,
    const o11y_attr_t *attrs,
    size_t attrs_len);

void o11y_observation_f64_observe(
    o11y_observation_f64_t *obs,
    double value,
    const o11y_attr_t *attrs,
    size_t attrs_len);

/**
 * Returns the meter for the instrumentation scope name. It belongs to sdk
 * and stays valid until o11y_destroy, as do the instruments created from it.
 * A NULL sdk gives a meter whose instruments record nothing.
 */
o11y_meter_t *o11y_meter(o11y_sdk_t *sdk, const char *name);
o11y_meter_t *o11y_meter_with_scope(
    o11y_sdk_t *sdk,
    const char *name,
    const char *version,
    const char *schema_url);

o11y_counter_i64_t o11y_meter_counter_i64(o11y_meter_t *meter, const char *name, const o11y_instrument_options_t *opts);
o11y_counter_f64_t o11y_meter_counter_f64(o11y_meter_t *meter, const char *name, const o11y_instrument_options_t *opts);
o11y_updown_i64_t o11y_meter_updown_i64(o11y_meter_t *meter, const char *name, const o11y_instrument_options_t *opts);
o11y_updown_f64_t o11y_meter_updown_f64(o11y_meter_t *meter, const char *name, const o11y_instrument_options_t *opts);
o11y_histogram_i64_t o11y_meter_histogram_i64(o11y_meter_t *meter, const char *name, const o11y_histogram_options_t *opts);
o11y_histogram_f64_t o11y_meter_histogram_f64(o11y_meter_t *meter, const char *name, const o11y_histogram_options_t *opts);
o11y_gauge_i64_t o11y_meter_gauge_i64(o11y_meter_t *meter, const char *name, const o11y_instrument_options_t *opts);
o11y_gauge_f64_t o11y_meter_gauge_f64(o11y_meter_t *meter, const char *name, const o11y_instrument_options_t *opts);

void o11y_counter_i64_add(o11y_counter_i64_t inst, const o11y_ctx_t *ctx, int64_t value, const o11y_attr_t *attrs, size_t attrs_len);
void o11y_counter_f64_add(o11y_counter_f64_t inst, const o11y_ctx_t *ctx, double value, const o11y_attr_t *attrs, size_t attrs_len);
void o11y_updown_i64_add(o11y_updown_i64_t inst, const o11y_ctx_t *ctx, int64_t value, const o11y_attr_t *attrs, size_t attrs_len);
void o11y_updown_f64_add(o11y_updown_f64_t inst, const o11y_ctx_t *ctx, double value, const o11y_attr_t *attrs, size_t attrs_len);
void o11y_histogram_i64_record(o11y_histogram_i64_t inst, const o11y_ctx_t *ctx, int64_t value, const o11y_attr_t *attrs, size_t attrs_len);
void o11y_histogram_f64_record(o11y_histogram_f64_t inst, const o11y_ctx_t *ctx, double value, const o11y_attr_t *attrs, size_t attrs_len);
void o11y_gauge_i64_record(o11y_gauge_i64_t inst, const o11y_ctx_t *ctx, int64_t value, const o11y_attr_t *attrs, size_t attrs_len);
void o11y_gauge_f64_record(o11y_gauge_f64_t inst, const o11y_ctx_t *ctx, double value, const o11y_attr_t *attrs, size_t attrs_len);

/*
 * Observable instruments. Each function registers callback, which libo11y
 * calls with userdata at every metric collection, on the collecting thread.
 * The callback reports values with o11y_observation_i64_observe or
 * o11y_observation_f64_observe under an internal provider lock, so callbacks
 * must not create or register instruments on the same meter or block past the
 * export deadline. The registration lasts until the SDK is destroyed, so
 * callback and userdata must stay valid until then. Returns
 * O11Y_ERR_INVALID_ARGUMENT for a NULL meter or callback, O11Y_ERR_SHUTDOWN
 * after shutdown, or O11Y_ERR_OUT_OF_MEMORY if allocation fails.
 */
o11y_err_t o11y_meter_observable_counter_i64(o11y_meter_t *meter, const char *name, const o11y_instrument_options_t *opts, o11y_observe_i64_fn callback, void *userdata);
o11y_err_t o11y_meter_observable_counter_f64(o11y_meter_t *meter, const char *name, const o11y_instrument_options_t *opts, o11y_observe_f64_fn callback, void *userdata);
o11y_err_t o11y_meter_observable_updown_i64(o11y_meter_t *meter, const char *name, const o11y_instrument_options_t *opts, o11y_observe_i64_fn callback, void *userdata);
o11y_err_t o11y_meter_observable_updown_f64(o11y_meter_t *meter, const char *name, const o11y_instrument_options_t *opts, o11y_observe_f64_fn callback, void *userdata);
o11y_err_t o11y_meter_observable_gauge_i64(o11y_meter_t *meter, const char *name, const o11y_instrument_options_t *opts, o11y_observe_i64_fn callback, void *userdata);
o11y_err_t o11y_meter_observable_gauge_f64(o11y_meter_t *meter, const char *name, const o11y_instrument_options_t *opts, o11y_observe_f64_fn callback, void *userdata);

/* =========================================================================
 * Structured logging, Events, and Wide Events (Record)
 * ========================================================================= */

/** Emits a structured log record. Unrecognized level values fall back to O11Y_LEVEL_INFO. */
void o11y_log(
    o11y_sdk_t *sdk,
    o11y_level_t level,
    const o11y_ctx_t *ctx,
    const char *message,
    const o11y_log_attr_t *attrs,
    size_t attrs_len);

static inline void o11y_log_debug(o11y_sdk_t *sdk, const o11y_ctx_t *ctx, const char *msg, const o11y_log_attr_t *attrs, size_t n) {
    o11y_log(sdk, O11Y_LEVEL_DEBUG, ctx, msg, attrs, n);
}
static inline void o11y_log_info(o11y_sdk_t *sdk, const o11y_ctx_t *ctx, const char *msg, const o11y_log_attr_t *attrs, size_t n) {
    o11y_log(sdk, O11Y_LEVEL_INFO, ctx, msg, attrs, n);
}
static inline void o11y_log_warn(o11y_sdk_t *sdk, const o11y_ctx_t *ctx, const char *msg, const o11y_log_attr_t *attrs, size_t n) {
    o11y_log(sdk, O11Y_LEVEL_WARN, ctx, msg, attrs, n);
}
static inline void o11y_log_error(o11y_sdk_t *sdk, const o11y_ctx_t *ctx, const char *msg, const o11y_log_attr_t *attrs, size_t n) {
    o11y_log(sdk, O11Y_LEVEL_ERROR, ctx, msg, attrs, n);
}

/**
 * Emits a contract-bearing event (exempt from level gates, carries event.name,
 * validated against spec event contracts). Never fails the host.
 */
void o11y_event(
    o11y_sdk_t *sdk,
    const o11y_ctx_t *ctx,
    const char *event_name,
    const o11y_log_attr_t *attrs,
    size_t attrs_len);

/** Wide-event accumulator (thread-safe; all methods are NULL-safe no-ops). */
o11y_record_t *o11y_record_create(void);
void o11y_record_destroy(o11y_record_t *rec);
void o11y_record_set(o11y_record_t *rec, o11y_log_attr_t attr);
void o11y_record_set_attrs(o11y_record_t *rec, const o11y_log_attr_t *attrs, size_t attrs_len);
void o11y_record_add(o11y_record_t *rec, const char *key, int64_t delta);
void o11y_record_max(o11y_record_t *rec, const char *key, double value);
void o11y_record_set_error(o11y_record_t *rec, const char *error_type);
void o11y_record_emit_event(
    o11y_record_t *rec,
    const o11y_ctx_t *ctx,
    o11y_sdk_t *sdk,
    const char *event_name,
    const o11y_log_attr_t *extra_attrs,
    size_t extra_attrs_len);

/* =========================================================================
 * W3C Context Propagation, Detached Work, and Child Process / Framed Sockets
 * ========================================================================= */

/**
 * Writes the span context and the egress-filtered baggage of ctx into
 * carrier with the SDK's propagators. It uses no process global, so it also
 * serves framed sockets and any other string-pair transport.
 */
void o11y_inject(const o11y_sdk_t *sdk, const o11y_ctx_t *ctx, const o11y_carrier_t *carrier);
/**
 * Returns a new context derived from parent with what the SDK's propagators
 * read from carrier. The caller releases it with o11y_ctx_destroy. With a
 * NULL sdk or carrier it returns a copy of parent.
 */
o11y_ctx_t *o11y_extract(const o11y_sdk_t *sdk, const o11y_ctx_t *parent, const o11y_carrier_t *carrier);

/*
 * Detached work: a job or a queue message that outlives the request that
 * created it. o11y_detached_capture stores the span context and the
 * egress-filtered baggage in a carrier, which marshals to text of at most
 * 32 KiB. The worker unmarshals it and starts a root span linked to the
 * captured one. The caller releases a carrier with o11y_detached_destroy
 * and the text of o11y_detached_marshal with o11y_string_free.
 */
o11y_err_t o11y_detached_capture(
    const o11y_sdk_t *sdk,
    const o11y_ctx_t *ctx,
    o11y_detached_carrier_t **out_carrier);
bool o11y_detached_is_zero(const o11y_detached_carrier_t *carrier);
o11y_span_context_t o11y_detached_span_context(const o11y_detached_carrier_t *carrier);
o11y_err_t o11y_detached_marshal(const o11y_detached_carrier_t *carrier, char **out_text);
o11y_err_t o11y_detached_unmarshal(const char *text, size_t text_len, o11y_detached_carrier_t **out_carrier);
void o11y_detached_destroy(o11y_detached_carrier_t *carrier);

o11y_linked_span_t *o11y_detached_start_linked(
    o11y_sdk_t *sdk,
    const o11y_ctx_t *ctx,
    const o11y_detached_carrier_t *carrier,
    const char *name,
    const o11y_span_start_options_t *options);
/**
 * Returns the context of the linked span, with the carrier's baggage merged
 * in. It belongs to linked and stays valid until o11y_linked_span_end.
 */
const o11y_ctx_t *o11y_linked_span_ctx(const o11y_linked_span_t *linked);
/**
 * Returns the linked span for the o11y_span_* functions. It belongs to
 * linked: end it with o11y_linked_span_end, never with o11y_span_end.
 */
o11y_span_t *o11y_linked_span_handle(o11y_linked_span_t *linked);
/** Ends the linked span and frees linked, its context and its span handle. */
void o11y_linked_span_end(o11y_linked_span_t *linked);

/*
 * Child processes. o11y_proc_env_entries returns "TRACEPARENT=..." and
 * "TRACESTATE=..." entries for a child's environment, which the caller
 * frees with o11y_string_free. It returns false, with both out-parameters
 * NULL, when ctx has no valid span context or memory runs out. Baggage never
 * travels through the environment. o11y_proc_extract_env returns a new
 * context from the two variables' values, which the caller releases with
 * o11y_ctx_destroy.
 */
bool o11y_proc_env_entries(
    const o11y_ctx_t *ctx,
    char **out_traceparent_entry,
    char **out_tracestate_entry);
o11y_ctx_t *o11y_proc_extract_env(
    const o11y_ctx_t *parent,
    const char *traceparent,
    const char *tracestate);

/* =========================================================================
 * Specification, sensitivity, and conformance utilities
 * ========================================================================= */

o11y_sensitivity_t o11y_spec_sensitivity_of(const char *key);
o11y_cardinality_t o11y_spec_cardinality_of(const char *key);

/**
 * Derives service.instance.id from Kubernetes pod identity (UUIDv5).
 * Returns true and writes 36-char UUID + NUL to out when pod identity exists,
 * or false when neither pod_uid nor pod_name is non-empty.
 */
bool o11y_derive_instance_id(
    const char *pod_uid,
    const char *pod_name,
    const char *namespace_name,
    char out[37]);

/** Sanitizes an OTLP endpoint URL (strips userinfo/query/fragment; "unparseable" on ambiguity). */
o11y_err_t o11y_sanitize_endpoint(const char *raw, size_t raw_len, char **out);

/**
 * Computes Go-exact PII canonical rendering and hmac-sha256:<32hex> token.
 * Zeroes out_canonical and out_token on entry before checking inputs.
 * Note that out_canonical is a NUL-terminated C string; if a length-delimited
 * string value contains embedded NUL bytes, all bytes are hashed into out_token
 * while C string callers reading *out_canonical stop at the first NUL byte.
 */
o11y_err_t o11y_pii_hash_value(
    const o11y_log_value_t *value,
    const uint8_t *key,
    size_t key_len,
    char **out_canonical,
    char out_token[45]);

/**
 * Validates an application attribute registry YAML buffer and renders the
 * conformance .want outcome ("ok N ns", violations, or "parse: <kind>").
 * out_status receives 0 (valid), 1 (policy violations), or 2 (parse error).
 */
o11y_err_t o11y_app_registry_check_bytes(
    const char *content,
    size_t content_len,
    char **out_want,
    int *out_status);

/* Verify standard int-sized enum ABI (reject -fshort-enums at compile time). */
#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
#define O11Y_ENUM_ABI_ASSERT(T) _Static_assert(sizeof(T) == sizeof(int), "libo11y requires int-sized enums (do not compile with -fshort-enums)")
#elif defined(__cplusplus) && __cplusplus >= 201103L
#define O11Y_ENUM_ABI_ASSERT(T) static_assert(sizeof(T) == sizeof(int), "libo11y requires int-sized enums (do not compile with -fshort-enums)")
#endif
#ifdef O11Y_ENUM_ABI_ASSERT
O11Y_ENUM_ABI_ASSERT(o11y_sensitivity_t);
O11Y_ENUM_ABI_ASSERT(o11y_cardinality_t);
O11Y_ENUM_ABI_ASSERT(o11y_err_t);
O11Y_ENUM_ABI_ASSERT(o11y_attr_kind_t);
O11Y_ENUM_ABI_ASSERT(o11y_log_value_kind_t);
O11Y_ENUM_ABI_ASSERT(o11y_env_mode_t);
O11Y_ENUM_ABI_ASSERT(o11y_protocol_t);
O11Y_ENUM_ABI_ASSERT(o11y_level_t);
O11Y_ENUM_ABI_ASSERT(o11y_console_format_t);
O11Y_ENUM_ABI_ASSERT(o11y_console_target_t);
O11Y_ENUM_ABI_ASSERT(o11y_pii_mode_t);
O11Y_ENUM_ABI_ASSERT(o11y_sampler_kind_t);
O11Y_ENUM_ABI_ASSERT(o11y_exemplar_filter_t);
O11Y_ENUM_ABI_ASSERT(o11y_propagator_kind_t);
O11Y_ENUM_ABI_ASSERT(o11y_span_kind_t);
O11Y_ENUM_ABI_ASSERT(o11y_status_code_t);
#undef O11Y_ENUM_ABI_ASSERT
#endif

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* O11Y_H */
