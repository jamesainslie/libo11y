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

static bool allow_only_tenant(const char *key, size_t key_len) {
    return key_len == 6 && memcmp(key, "tenant", 6) == 0;
}

static void test_w3c_inject_extract_and_baggage_egress_filter(void) {
    o11y_test_options_t topts = o11y_test_options_default();
    topts.baggage_egress_allow = allow_only_tenant;
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

int main(void) {
    RUN_TEST(test_w3c_inject_extract_and_baggage_egress_filter);
    RUN_TEST(test_detached_carrier_roundtrip_and_start_linked);
    RUN_TEST(test_proc_env_propagation);
    TEST_SUMMARY("test_propagation");
}
