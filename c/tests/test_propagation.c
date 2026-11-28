#include "o11y/test.h"
#include "test_framework.h"

struct header_map {
    char keys[16][64];
    char vals[16][512];
    size_t len;
};

static const char *map_get(void *userdata, const char *key) {
    struct header_map *m = (struct header_map *)userdata;
    for (size_t i = 0; i < m->len; i++) {
        if (strcmp(m->keys[i], key) == 0) return m->vals[i];
    }
    return NULL;
}

static void map_set(void *userdata, const char *key, const char *value) {
    struct header_map *m = (struct header_map *)userdata;
    for (size_t i = 0; i < m->len; i++) {
        if (strcmp(m->keys[i], key) == 0) {
            snprintf(m->vals[i], sizeof(m->vals[i]), "%s", value);
            return;
        }
    }
    if (m->len < 16) {
        snprintf(m->keys[m->len], sizeof(m->keys[m->len]), "%s", key);
        snprintf(m->vals[m->len], sizeof(m->vals[m->len]), "%s", value);
        m->len++;
    }
}

/* Allows the one baggage key that userdata names. */
static bool allow_named_key(void *userdata, const char *key) {
    return strcmp(key, (const char *)userdata) == 0;
}

static void test_w3c_inject_extract_and_baggage_egress_filter(void) {
    o11y_test_options_t topts = o11y_test_options_default();
    topts.baggage_egress_allow = allow_named_key;
    topts.baggage_egress_allow_userdata = "tenant";
    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));
    o11y_sdk_t *sdk = o11y_test_sdk(rec);

    o11y_tracer_t *tr = o11y_tracer(sdk, "edge");
    o11y_span_t *sp = o11y_tracer_start(tr, NULL, "outbound", NULL);
    o11y_span_context_t orig = o11y_span_context(sp);

    o11y_ctx_t *c1 = o11y_ctx_with_span(NULL, sp);
    o11y_ctx_t *c2 = o11y_ctx_with_baggage_item(c1, "tenant", "acme");
    o11y_ctx_t *c3 = o11y_ctx_with_baggage_item(c2, "secret_token", "drop-me");

    struct header_map hdrs = {0};
    o11y_carrier_t carrier = { .userdata = &hdrs, .get = map_get, .set = map_set };
    o11y_inject(sdk, c3, &carrier);

    const char *tp = map_get(&hdrs, "traceparent");
    const char *bag = map_get(&hdrs, "baggage");
    ASSERT_NOT_NULL(tp);
    ASSERT_NOT_NULL(bag);
    ASSERT_STR_CONTAINS(bag, "tenant=acme");
    ASSERT_TRUE(strstr(bag, "secret_token") == NULL);

    /* Extract into fresh context */
    o11y_ctx_t *extracted = o11y_extract(sdk, NULL, &carrier);
    ASSERT_NOT_NULL(extracted);
    o11y_span_context_t esc = o11y_ctx_span_context(extracted);
    ASSERT_TRUE(o11y_span_context_is_valid(esc));
    ASSERT_TRUE(esc.remote);
    ASSERT_TRUE(memcmp(orig.trace_id.bytes, esc.trace_id.bytes, 16) == 0);
    ASSERT_TRUE(memcmp(orig.span_id.bytes, esc.span_id.bytes, 8) == 0);
    ASSERT_EQ_STR("acme", o11y_ctx_baggage_get(extracted, "tenant"));
    ASSERT_NULL(o11y_ctx_baggage_get(extracted, "secret_token"));

    o11y_ctx_destroy(extracted);
    o11y_ctx_destroy(c3);
    o11y_ctx_destroy(c2);
    o11y_ctx_destroy(c1);
    o11y_span_end(sp);
    o11y_test_destroy(rec);
}

static void test_detached_carrier_roundtrip_and_start_linked(void) {
    o11y_test_options_t topts = o11y_test_options_default();
    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));
    o11y_sdk_t *sdk = o11y_test_sdk(rec);

    o11y_tracer_t *tr = o11y_tracer(sdk, "api");
    o11y_span_t *req = o11y_tracer_start(tr, NULL, "POST /jobs", NULL);
    o11y_span_context_t req_sc = o11y_span_context(req);
    o11y_ctx_t *c1 = o11y_ctx_with_span(NULL, req);
    o11y_ctx_t *c2 = o11y_ctx_with_baggage_item(c1, "job_origin", "checkout");

    o11y_detached_carrier_t *cap = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_detached_capture(sdk, c2, &cap));
    ASSERT_NOT_NULL(cap);
    ASSERT_FALSE(o11y_detached_is_zero(cap));

    char *wire = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_detached_marshal(cap, &wire));
    ASSERT_NOT_NULL(wire);
    ASSERT_STR_CONTAINS(wire, "traceparent=");
    ASSERT_STR_CONTAINS(wire, "baggage=");

    o11y_detached_carrier_t *parsed = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_detached_unmarshal(wire, strlen(wire), &parsed));
    ASSERT_NOT_NULL(parsed);
    o11y_span_context_t psc = o11y_detached_span_context(parsed);
    ASSERT_TRUE(memcmp(req_sc.trace_id.bytes, psc.trace_id.bytes, 16) == 0);
    ASSERT_TRUE(memcmp(req_sc.span_id.bytes, psc.span_id.bytes, 8) == 0);

    /* Invalid carrier text rejected */
    o11y_detached_carrier_t *bad = NULL;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_CARRIER, o11y_detached_unmarshal("traceparent=not-valid", 21, &bad));
    ASSERT_NULL(bad);

    /* Start linked root span for background worker */
    o11y_linked_span_t *job = o11y_detached_start_linked(sdk, NULL, parsed, "worker.send_email", NULL);
    ASSERT_NOT_NULL(job);
    const o11y_ctx_t *job_ctx = o11y_linked_span_ctx(job);
    ASSERT_EQ_STR("checkout", o11y_ctx_baggage_get(job_ctx, "job_origin"));
    o11y_span_set_attr(o11y_linked_span_handle(job), o11y_kv_str("job.type", "receipt"));
    o11y_linked_span_end(job);

    o11y_detached_destroy(parsed);
    o11y_string_free(wire);
    o11y_detached_destroy(cap);
    o11y_ctx_destroy(c2);
    o11y_ctx_destroy(c1);
    o11y_span_end(req);

    const o11y_test_span_t *job_span = o11y_test_find_span(rec, "worker.send_email");
    ASSERT_NOT_NULL(job_span);
    /* Must be a new root trace linked to req_sc */
    o11y_span_context_t jsc = o11y_test_span_context(job_span);
    ASSERT_TRUE(memcmp(req_sc.trace_id.bytes, jsc.trace_id.bytes, 16) != 0);
    ASSERT_EQ_SIZE(1, o11y_test_span_link_count(job_span));
    o11y_span_context_t link_sc = o11y_test_span_link_context(job_span, 0);
    ASSERT_TRUE(memcmp(req_sc.trace_id.bytes, link_sc.trace_id.bytes, 16) == 0);
    ASSERT_EQ_STR("receipt", o11y_test_span_attr_str(job_span, "job.type"));

    o11y_test_destroy(rec);
}

static void test_proc_env_propagation(void) {
    o11y_test_options_t topts = o11y_test_options_default();
    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));
    o11y_sdk_t *sdk = o11y_test_sdk(rec);

    o11y_span_t *parent = o11y_tracer_start(o11y_tracer(sdk, "cli"), NULL, "parent", NULL);
    o11y_span_context_t psc = o11y_span_context(parent);
    o11y_ctx_t *pctx = o11y_ctx_with_span(NULL, parent);

    char *tp_entry = NULL;
    char *ts_entry = NULL;
    ASSERT_TRUE(o11y_proc_env_entries(pctx, &tp_entry, &ts_entry));
    ASSERT_NOT_NULL(tp_entry);
    ASSERT_NOT_NULL(ts_entry);
    ASSERT_TRUE(strncmp(tp_entry, "TRACEPARENT=00-", 15) == 0);
    ASSERT_EQ_STR("TRACESTATE=", ts_entry);

    o11y_ctx_t *child_ctx = o11y_proc_extract_env(NULL, tp_entry + 12, "vendor=xyz");
    ASSERT_NOT_NULL(child_ctx);
    o11y_span_context_t csc = o11y_ctx_span_context(child_ctx);
    ASSERT_TRUE(csc.remote);
    ASSERT_TRUE(memcmp(psc.trace_id.bytes, csc.trace_id.bytes, 16) == 0);
    ASSERT_TRUE(memcmp(psc.span_id.bytes, csc.span_id.bytes, 8) == 0);
    ASSERT_EQ_STR("vendor=xyz", csc.trace_state);

    o11y_ctx_destroy(child_ctx);
    o11y_string_free(tp_entry);
    o11y_string_free(ts_entry);
    o11y_ctx_destroy(pctx);
    o11y_span_end(parent);
    o11y_test_destroy(rec);
}

static o11y_sdk_t *init_hermetic(const o11y_options_t *base) {
    o11y_options_t opts = *base;
    opts.env_mode = O11Y_ENV_HERMETIC;
    opts.service_name = "propagation";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    opts.console_enabled = false;
    opts.runtime_metrics = false;
    o11y_sdk_t *sdk = NULL;
    if (o11y_init(&opts, &sdk, NULL) != O11Y_OK) return NULL;
    return sdk;
}

/* Two SDKs in one process each keep their own filter and userdata. */
static void test_baggage_egress_filter_is_per_sdk(void) {
    o11y_options_t opts = o11y_options_default();
    opts.baggage_egress_allow = allow_named_key;
    opts.baggage_egress_allow_userdata = "tenant";
    o11y_sdk_t *tenant_sdk = init_hermetic(&opts);
    opts.baggage_egress_allow_userdata = "region";
    o11y_sdk_t *region_sdk = init_hermetic(&opts);
    ASSERT_NOT_NULL(tenant_sdk);
    ASSERT_NOT_NULL(region_sdk);

    o11y_ctx_t *c1 = o11y_ctx_with_baggage_item(NULL, "tenant", "acme");
    o11y_ctx_t *c2 = o11y_ctx_with_baggage_item(c1, "region", "eu");

    struct header_map tenant_hdrs = {0};
    o11y_carrier_t tenant_carrier = { .userdata = &tenant_hdrs, .get = map_get, .set = map_set };
    o11y_inject(tenant_sdk, c2, &tenant_carrier);
    ASSERT_EQ_STR("tenant=acme", map_get(&tenant_hdrs, "baggage"));

    struct header_map region_hdrs = {0};
    o11y_carrier_t region_carrier = { .userdata = &region_hdrs, .get = map_get, .set = map_set };
    o11y_inject(region_sdk, c2, &region_carrier);
    ASSERT_EQ_STR("region=eu", map_get(&region_hdrs, "baggage"));

    o11y_ctx_destroy(c2);
    o11y_ctx_destroy(c1);
    o11y_destroy(region_sdk);
    o11y_destroy(tenant_sdk);
}

/* A propagators list replaces the default pair. */
static void test_propagators_option_replaces_the_default(void) {
    o11y_propagator_t only_trace_context[] = { { .kind = O11Y_PROPAGATOR_TRACE_CONTEXT } };
    o11y_test_options_t topts = o11y_test_options_default();
    topts.propagators = only_trace_context;
    topts.propagators_len = 1;
    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));
    o11y_sdk_t *sdk = o11y_test_sdk(rec);

    o11y_span_t *sp = o11y_tracer_start(o11y_tracer(sdk, "edge"), NULL, "outbound", NULL);
    o11y_ctx_t *c1 = o11y_ctx_with_span(NULL, sp);
    o11y_ctx_t *c2 = o11y_ctx_with_baggage_item(c1, "tenant", "acme");

    struct header_map hdrs = {0};
    o11y_carrier_t carrier = { .userdata = &hdrs, .get = map_get, .set = map_set };
    o11y_inject(sdk, c2, &carrier);
    ASSERT_NOT_NULL(map_get(&hdrs, "traceparent"));
    ASSERT_NULL(map_get(&hdrs, "baggage"));

    o11y_ctx_destroy(c2);
    o11y_ctx_destroy(c1);
    o11y_span_end(sp);
    o11y_test_destroy(rec);

    /* An unknown kind and an empty custom propagator fail setup. */
    o11y_propagator_t unknown[] = { { .kind = (o11y_propagator_kind_t)99 } };
    o11y_diagnostic_t diag = {0};
    topts.propagators = unknown;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_test_start(&topts, &rec, &diag));
    ASSERT_NULL(rec);
    ASSERT_STR_CONTAINS(diag.message, "propagator kind");

    o11y_propagator_t empty_custom[] = { { .kind = O11Y_PROPAGATOR_CUSTOM } };
    topts.propagators = empty_custom;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_test_start(&topts, &rec, &diag));
    ASSERT_NULL(rec);
}

/* A legacy single-header format: "x-legacy-trace: <trace id hex>-<span id hex>". */
static void legacy_inject(void *userdata, const o11y_ctx_t *ctx, const o11y_carrier_t *carrier) {
    int *calls = (int *)userdata;
    (*calls)++;
    o11y_span_context_t sc = o11y_ctx_span_context(ctx);
    if (!o11y_span_context_is_valid(sc)) return;
    char value[33 + 17];
    o11y_trace_id_hex(sc.trace_id, value);
    value[32] = '-';
    o11y_span_id_hex(sc.span_id, value + 33);
    carrier->set(carrier->userdata, "x-legacy-trace", value);
}

static o11y_ctx_t *legacy_extract(void *userdata, const o11y_ctx_t *parent, const o11y_carrier_t *carrier) {
    (void)userdata;
    const char *value = carrier->get(carrier->userdata, "x-legacy-trace");
    if (value == NULL || strlen(value) != 49 || value[32] != '-') return NULL;
    char trace_hex[33];
    memcpy(trace_hex, value, 32);
    trace_hex[32] = '\0';
    o11y_span_context_t sc = {0};
    if (!o11y_trace_id_parse_hex(trace_hex, &sc.trace_id)) return NULL;
    if (!o11y_span_id_parse_hex(value + 33, &sc.span_id)) return NULL;
    sc.trace_flags = 1;
    sc.remote = true;
    return o11y_ctx_with_span_context(parent, sc);
}

static void test_custom_propagator_beside_the_w3c_pair(void) {
    static const char *const legacy_fields[] = { "x-legacy-trace" };
    int inject_calls = 0;
    o11y_propagator_t props[] = {
        { .kind = O11Y_PROPAGATOR_TRACE_CONTEXT },
        { .kind = O11Y_PROPAGATOR_BAGGAGE },
        {
            .kind = O11Y_PROPAGATOR_CUSTOM,
            .userdata = &inject_calls,
            .inject = legacy_inject,
            .extract = legacy_extract,
            .fields = legacy_fields,
            .fields_len = 1,
        },
    };
    o11y_test_options_t topts = o11y_test_options_default();
    topts.propagators = props;
    topts.propagators_len = 3;
    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));
    o11y_sdk_t *sdk = o11y_test_sdk(rec);

    o11y_span_t *sp = o11y_tracer_start(o11y_tracer(sdk, "edge"), NULL, "outbound", NULL);
    o11y_span_context_t orig = o11y_span_context(sp);
    o11y_ctx_t *c1 = o11y_ctx_with_span(NULL, sp);
    o11y_ctx_t *c2 = o11y_ctx_with_baggage_item(c1, "tenant", "acme");

    struct header_map hdrs = {0};
    o11y_carrier_t carrier = { .userdata = &hdrs, .get = map_get, .set = map_set };
    o11y_inject(sdk, c2, &carrier);
    ASSERT_EQ_INT(1, inject_calls);
    ASSERT_NOT_NULL(map_get(&hdrs, "traceparent"));
    ASSERT_EQ_STR("tenant=acme", map_get(&hdrs, "baggage"));
    const char *legacy = map_get(&hdrs, "x-legacy-trace");
    ASSERT_NOT_NULL(legacy);
    ASSERT_EQ_SIZE(49, strlen(legacy));

    /* A carrier with only the legacy header is extracted by the callback,
     * and the baggage of the parent context survives it. */
    struct header_map legacy_only = {0};
    map_set(&legacy_only, "x-legacy-trace", legacy);
    o11y_carrier_t legacy_carrier = { .userdata = &legacy_only, .get = map_get, .set = map_set };
    o11y_ctx_t *parent = o11y_ctx_with_baggage_item(NULL, "region", "eu");
    o11y_ctx_t *extracted = o11y_extract(sdk, parent, &legacy_carrier);
    ASSERT_NOT_NULL(extracted);
    o11y_span_context_t esc = o11y_ctx_span_context(extracted);
    ASSERT_TRUE(esc.remote);
    ASSERT_TRUE(memcmp(orig.trace_id.bytes, esc.trace_id.bytes, 16) == 0);
    ASSERT_TRUE(memcmp(orig.span_id.bytes, esc.span_id.bytes, 8) == 0);
    ASSERT_EQ_STR("eu", o11y_ctx_baggage_get(extracted, "region"));

    /* An empty carrier leaves the parent context as it was. */
    struct header_map empty = {0};
    o11y_carrier_t empty_carrier = { .userdata = &empty, .get = map_get, .set = map_set };
    o11y_ctx_t *unchanged = o11y_extract(sdk, parent, &empty_carrier);
    ASSERT_NOT_NULL(unchanged);
    ASSERT_FALSE(o11y_span_context_is_valid(o11y_ctx_span_context(unchanged)));
    ASSERT_EQ_STR("eu", o11y_ctx_baggage_get(unchanged, "region"));

    o11y_ctx_destroy(unchanged);
    o11y_ctx_destroy(extracted);
    o11y_ctx_destroy(parent);
    o11y_ctx_destroy(c2);
    o11y_ctx_destroy(c1);
    o11y_span_end(sp);
    o11y_test_destroy(rec);
}

/* A context owns its strings: it outlives its parent context and its span. */
static void test_context_outlives_its_parent_and_its_span(void) {
    o11y_test_options_t topts = o11y_test_options_default();
    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));
    o11y_sdk_t *sdk = o11y_test_sdk(rec);

    o11y_span_context_t remote = {0};
    ASSERT_TRUE(o11y_trace_id_parse_hex("4bf92f3577b34da6a3ce929d0e0e4736", &remote.trace_id));
    ASSERT_TRUE(o11y_span_id_parse_hex("00f067aa0ba902b7", &remote.span_id));
    remote.trace_flags = 1;
    remote.remote = true;
    char trace_state[] = "vendor=abc";
    remote.trace_state = trace_state;

    o11y_ctx_t *root = o11y_ctx_with_span_context(NULL, remote);
    memset(trace_state, 'x', sizeof(trace_state) - 1); /* the context kept its own copy */
    o11y_span_t *sp = o11y_tracer_start(o11y_tracer(sdk, "edge"), root, "child", NULL);
    ASSERT_EQ_STR("vendor=abc", o11y_span_context(sp).trace_state);

    o11y_ctx_t *with_span = o11y_ctx_with_span(root, sp);
    o11y_ctx_t *with_bag = o11y_ctx_with_baggage_item(with_span, "tenant", "acme");
    o11y_span_context_t child = o11y_span_context(sp);
    o11y_ctx_destroy(root);
    o11y_ctx_destroy(with_span);
    o11y_span_end(sp);

    /* Two reads return the same string: the getter allocates nothing. */
    const char *first = o11y_ctx_baggage_get(with_bag, "tenant");
    ASSERT_EQ_STR("acme", first);
    ASSERT_TRUE(first == o11y_ctx_baggage_get(with_bag, "tenant"));

    o11y_span_context_t kept = o11y_ctx_span_context(with_bag);
    ASSERT_TRUE(memcmp(child.span_id.bytes, kept.span_id.bytes, 8) == 0);
    ASSERT_EQ_STR("vendor=abc", kept.trace_state);

    /* A record logged after the span ended still correlates with it. */
    o11y_log_info(sdk, with_bag, "after the span ended", NULL, 0);
    const o11y_test_log_t *log = o11y_test_find_log(rec, "after the span ended");
    ASSERT_NOT_NULL(log);
    o11y_span_context_t logged = o11y_test_log_span_context(log);
    ASSERT_TRUE(memcmp(child.span_id.bytes, logged.span_id.bytes, 8) == 0);

    o11y_ctx_destroy(with_bag);
    o11y_test_destroy(rec);
}

struct scratch_carrier_state {
    char buf[128];
};

static const char *reused_buf_get(void *userdata, const char *key) {
    struct scratch_carrier_state *s = (struct scratch_carrier_state *)userdata;
    if (strcmp(key, "traceparent") == 0) {
        snprintf(s->buf, sizeof(s->buf), "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
        return s->buf;
    }
    if (strcmp(key, "tracestate") == 0) {
        snprintf(s->buf, sizeof(s->buf), "vendor=kept");
        return s->buf;
    }
    if (strcmp(key, "baggage") == 0) {
        snprintf(s->buf, sizeof(s->buf), "tenant=acme");
        return s->buf;
    }
    return NULL;
}

static void noop_set(void *userdata, const char *key, const char *value) {
    (void)userdata;
    (void)key;
    (void)value;
}

static void test_carrier_get_reused_buffer_and_baggage_validation(void) {
    o11y_test_options_t topts = o11y_test_options_default();
    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));
    o11y_sdk_t *sdk = o11y_test_sdk(rec);

    struct scratch_carrier_state state = {0};
    o11y_carrier_t carrier = { .userdata = &state, .get = reused_buf_get, .set = noop_set };
    o11y_ctx_t *ext = o11y_extract(sdk, NULL, &carrier);
    ASSERT_NOT_NULL(ext);
    o11y_span_context_t sc = o11y_ctx_span_context(ext);
    ASSERT_TRUE(o11y_span_context_is_valid(sc));
    ASSERT_EQ_STR("vendor=kept", sc.trace_state);
    ASSERT_EQ_STR("acme", o11y_ctx_baggage_get(ext, "tenant"));

    /* Invalid W3C baggage key (whitespace) must not be kept or injected */
    o11y_ctx_t *bad_bag = o11y_ctx_with_baggage_item(ext, "bad key", "val");
    ASSERT_NOT_NULL(bad_bag);
    ASSERT_NULL(o11y_ctx_baggage_get(bad_bag, "bad key"));

    /* Enforce 64-member W3C limit */
    o11y_ctx_t *many = o11y_ctx_create();
    for (int i = 0; i < 70; i++) {
        char kbuf[16];
        snprintf(kbuf, sizeof(kbuf), "k%d", i);
        o11y_ctx_t *next = o11y_ctx_with_baggage_item(many, kbuf, "v");
        o11y_ctx_destroy(many);
        many = next;
    }
    ASSERT_EQ_STR("v", o11y_ctx_baggage_get(many, "k63"));
    ASSERT_NULL(o11y_ctx_baggage_get(many, "k64"));

    o11y_ctx_destroy(many);
    o11y_ctx_destroy(bad_bag);
    o11y_ctx_destroy(ext);
    o11y_test_destroy(rec);
}

static o11y_sdk_t *init_with_otel_propagators(const char *env_val, const o11y_propagator_t *explicit_props, size_t n, o11y_err_t *out_err, o11y_diagnostic_t *diag) {
    o11y_env_pair_t env_pairs[] = {
        { "OTEL_SERVICE_NAME", "prop-env" },
        { "OTEL_RESOURCE_ATTRIBUTES", "deployment.environment.name=test" },
        { "OTEL_TRACES_EXPORTER", "none" },
        { "OTEL_METRICS_EXPORTER", "none" },
        { "OTEL_LOGS_EXPORTER", "none" },
        { "OTEL_PROPAGATORS", env_val },
    };
    o11y_options_t opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_PAIRS;
    opts.env_pairs = env_pairs;
    opts.env_pairs_len = 6;
    opts.console_enabled = false;
    opts.runtime_metrics = false;
    opts.sampler_kind = O11Y_SAMPLER_ALWAYS_ON;
    opts.propagators = explicit_props;
    opts.propagators_len = n;
    o11y_sdk_t *sdk = NULL;
    o11y_err_t rc = o11y_init(&opts, &sdk, diag);
    if (out_err) *out_err = rc;
    return sdk;
}

static void test_otel_propagators_env(void) {
    o11y_err_t rc = O11Y_OK;
    o11y_diagnostic_t diag = {0};

    /* 1. tracecontext only */
    o11y_sdk_t *tc_sdk = init_with_otel_propagators(" tracecontext , tracecontext ", NULL, 0, &rc, &diag);
    ASSERT_EQ_ERR(O11Y_OK, rc);
    ASSERT_NOT_NULL(tc_sdk);
    ASSERT_STR_CONTAINS(o11y_effective_config(tc_sdk), "o11y.config.propagators=traceparent,tracestate");

    o11y_span_t *sp = o11y_tracer_start(o11y_tracer(tc_sdk, "p"), NULL, "op", NULL);
    o11y_ctx_t *c1 = o11y_ctx_with_span(NULL, sp);
    o11y_ctx_t *c2 = o11y_ctx_with_baggage_item(c1, "k", "v");
    struct header_map hdrs = {0};
    o11y_carrier_t carrier = { .userdata = &hdrs, .get = map_get, .set = map_set };
    o11y_inject(tc_sdk, c2, &carrier);
    ASSERT_NOT_NULL(map_get(&hdrs, "traceparent"));
    ASSERT_NULL(map_get(&hdrs, "baggage"));
    o11y_ctx_destroy(c2);
    o11y_ctx_destroy(c1);
    o11y_span_end(sp);
    o11y_destroy(tc_sdk);

    /* 2. baggage only */
    o11y_sdk_t *bag_sdk = init_with_otel_propagators("baggage", NULL, 0, &rc, &diag);
    ASSERT_EQ_ERR(O11Y_OK, rc);
    sp = o11y_tracer_start(o11y_tracer(bag_sdk, "p"), NULL, "op", NULL);
    c1 = o11y_ctx_with_span(NULL, sp);
    c2 = o11y_ctx_with_baggage_item(c1, "k", "v");
    memset(&hdrs, 0, sizeof(hdrs));
    o11y_inject(bag_sdk, c2, &carrier);
    ASSERT_NULL(map_get(&hdrs, "traceparent"));
    ASSERT_EQ_STR("k=v", map_get(&hdrs, "baggage"));
    o11y_ctx_destroy(c2);
    o11y_ctx_destroy(c1);
    o11y_span_end(sp);
    o11y_destroy(bag_sdk);

    /* 3. none injects nothing and sets effective config to none */
    o11y_sdk_t *none_sdk = init_with_otel_propagators("none", NULL, 0, &rc, &diag);
    ASSERT_EQ_ERR(O11Y_OK, rc);
    ASSERT_STR_CONTAINS(o11y_effective_config(none_sdk), "o11y.config.propagators=none");
    sp = o11y_tracer_start(o11y_tracer(none_sdk, "p"), NULL, "op", NULL);
    c1 = o11y_ctx_with_span(NULL, sp);
    c2 = o11y_ctx_with_baggage_item(c1, "k", "v");
    memset(&hdrs, 0, sizeof(hdrs));
    o11y_inject(none_sdk, c2, &carrier);
    ASSERT_EQ_SIZE(0, hdrs.len);
    o11y_ctx_destroy(c2);
    o11y_ctx_destroy(c1);
    o11y_span_end(sp);
    o11y_destroy(none_sdk);

    /* 4. Unknown propagator fails with O11Y_ERR_UNSUPPORTED_PROPAGATOR, even next to none, and explicit option beats it */
    o11y_sdk_t *bad_sdk = init_with_otel_propagators("bogus", NULL, 0, &rc, &diag);
    ASSERT_EQ_ERR(O11Y_ERR_UNSUPPORTED_PROPAGATOR, rc);
    ASSERT_NULL(bad_sdk);
    ASSERT_STR_CONTAINS(diag.message, "bogus");

    bad_sdk = init_with_otel_propagators("none,TraceContext", NULL, 0, &rc, &diag);
    ASSERT_EQ_ERR(O11Y_ERR_UNSUPPORTED_PROPAGATOR, rc);
    ASSERT_NULL(bad_sdk);

    o11y_propagator_t override_tc[] = { { .kind = O11Y_PROPAGATOR_TRACE_CONTEXT } };
    o11y_sdk_t *override_sdk = init_with_otel_propagators("bogus", override_tc, 1, &rc, &diag);
    ASSERT_EQ_ERR(O11Y_OK, rc);
    ASSERT_NOT_NULL(override_sdk);
    o11y_destroy(override_sdk);
}

int main(void) {
    RUN_TEST(test_w3c_inject_extract_and_baggage_egress_filter);
    RUN_TEST(test_baggage_egress_filter_is_per_sdk);
    RUN_TEST(test_propagators_option_replaces_the_default);
    RUN_TEST(test_custom_propagator_beside_the_w3c_pair);
    RUN_TEST(test_context_outlives_its_parent_and_its_span);
    RUN_TEST(test_detached_carrier_roundtrip_and_start_linked);
    RUN_TEST(test_proc_env_propagation);
    RUN_TEST(test_carrier_get_reused_buffer_and_baggage_validation);
    RUN_TEST(test_otel_propagators_env);
    TEST_SUMMARY("test_propagation");
}
