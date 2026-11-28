#include "o11y/test.h"
#include "test_framework.h"

static void test_span_hierarchy_and_attributes(void) {
    o11y_test_options_t topts = o11y_test_options_default();
    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));

    o11y_sdk_t *sdk = o11y_test_sdk(rec);
    o11y_tracer_t *tr = o11y_tracer_with_scope(sdk, "payments", "1.0.0", O11Y_SCHEMA_URL);

    const char *tags[] = { "vip", "eu" };
    int64_t nums[] = { 10, 20 };
    o11y_attr_t start_attrs[] = {
        o11y_kv_str("http.request.method", "POST"),
        o11y_kv_int("http.response.status_code", 201),
        o11y_kv_double("payment.amount", 49.95),
        o11y_kv_bool("payment.retry", false),
        o11y_kv_str_array("payment.tags", tags, 2),
        o11y_kv_int_array("payment.steps", nums, 2),
    };
    o11y_span_start_options_t sopts = {
        .kind = O11Y_SPAN_KIND_SERVER,
        .attributes = start_attrs,
        .attributes_len = 6,
    };
    o11y_span_t *parent = o11y_tracer_start(tr, NULL, "initial-name", &sopts);
    ASSERT_TRUE(o11y_span_is_recording(parent));
    o11y_span_set_name(parent, "POST /charge");
    o11y_span_set_attr(parent, o11y_kv_str(O11Y_ATTR_OUTCOME, O11Y_OUTCOME_SUCCESS));

    o11y_ctx_t *pctx = o11y_ctx_with_span(NULL, parent);

    /* Child span inherits parent's trace_id and parent_span_id */
    o11y_span_start_options_t copts = { .kind = O11Y_SPAN_KIND_CLIENT };
    o11y_span_t *child = o11y_tracer_start(tr, pctx, "db.query", &copts);
    o11y_span_add_event(child, "query.prepared", NULL, 0, 0);
    o11y_span_record_error(child, "TimeoutError", "deadline exceeded", NULL, 0);
    o11y_span_set_status(child, O11Y_STATUS_ERROR, "db timeout");
    o11y_span_set_status(child, O11Y_STATUS_UNSET, "ignored"); /* cannot downgrade */
    o11y_span_end(child);

    /* New root span starts a distinct trace */
    o11y_span_start_options_t ropts = { .kind = O11Y_SPAN_KIND_PRODUCER, .new_root = true };
    o11y_span_t *root2 = o11y_tracer_start(tr, pctx, "async.publish", &ropts);
    o11y_span_link_t link = { .span_context = o11y_span_context(parent), .attributes = NULL, .attributes_len = 0 };
    o11y_span_add_link(root2, &link);
    o11y_span_set_status(root2, O11Y_STATUS_OK, "");
    o11y_span_set_status(root2, O11Y_STATUS_ERROR, "cannot override ok");
    o11y_span_end(root2);

    o11y_ctx_destroy(pctx);
    o11y_span_end(parent);

    ASSERT_EQ_SIZE(3, o11y_test_span_count(rec));

    const o11y_test_span_t *sp_parent = o11y_test_find_span(rec, "POST /charge");
    const o11y_test_span_t *sp_child = o11y_test_find_span(rec, "db.query");
    const o11y_test_span_t *sp_root2 = o11y_test_find_span(rec, "async.publish");
    ASSERT_NOT_NULL(sp_parent);
    ASSERT_NOT_NULL(sp_child);
    ASSERT_NOT_NULL(sp_root2);

    ASSERT_EQ_INT(O11Y_SPAN_KIND_SERVER, o11y_test_span_kind(sp_parent));
    ASSERT_EQ_STR("POST", o11y_test_span_attr_str(sp_parent, "http.request.method"));
    int64_t status_code = 0;
    ASSERT_TRUE(o11y_test_span_attr_int(sp_parent, "http.response.status_code", &status_code));
    ASSERT_EQ_INT(201, status_code);
    double amount = 0.0;
    ASSERT_TRUE(o11y_test_span_attr_double(sp_parent, "payment.amount", &amount));
    ASSERT_EQ_DBL(49.95, amount, 1e-6);
    bool retry = true;
    ASSERT_TRUE(o11y_test_span_attr_bool(sp_parent, "payment.retry", &retry));
    ASSERT_FALSE(retry);

    /* Trace/parent linkage */
    o11y_span_context_t psc = o11y_test_span_context(sp_parent);
    o11y_span_context_t csc = o11y_test_span_context(sp_child);
    o11y_span_context_t cparent = o11y_test_span_parent_context(sp_child);
    ASSERT_TRUE(memcmp(psc.trace_id.bytes, csc.trace_id.bytes, 16) == 0);
    ASSERT_TRUE(memcmp(psc.span_id.bytes, cparent.span_id.bytes, 8) == 0);

    /* Child events & status */
    ASSERT_EQ_INT(O11Y_STATUS_ERROR, o11y_test_span_status_code(sp_child));
    ASSERT_EQ_STR("db timeout", o11y_test_span_status_description(sp_child));
    ASSERT_EQ_SIZE(2, o11y_test_span_event_count(sp_child));
    ASSERT_EQ_STR("query.prepared", o11y_test_span_event_name(sp_child, 0));
    ASSERT_EQ_STR("exception", o11y_test_span_event_name(sp_child, 1));
    ASSERT_EQ_STR("TimeoutError", o11y_test_span_event_attr_str(sp_child, 1, "exception.type"));
    ASSERT_EQ_STR("deadline exceeded", o11y_test_span_event_attr_str(sp_child, 1, "exception.message"));

    /* New root has distinct trace_id, OK status preserved, and 1 link to parent */
    o11y_span_context_t r2sc = o11y_test_span_context(sp_root2);
    ASSERT_TRUE(memcmp(psc.trace_id.bytes, r2sc.trace_id.bytes, 16) != 0);
    ASSERT_EQ_INT(O11Y_STATUS_OK, o11y_test_span_status_code(sp_root2));
    ASSERT_EQ_SIZE(1, o11y_test_span_link_count(sp_root2));
    o11y_span_context_t linked_sc = o11y_test_span_link_context(sp_root2, 0);
    ASSERT_TRUE(memcmp(psc.span_id.bytes, linked_sc.span_id.bytes, 8) == 0);

    /* Child inherits parent's trace_id, parent_span_id, and trace_state when remote */
    o11y_span_context_t remote_parent = {0};
    ASSERT_TRUE(o11y_trace_id_parse_hex("4bf92f3577b34da6a3ce929d0e0e4736", &remote_parent.trace_id));
    ASSERT_TRUE(o11y_span_id_parse_hex("00f067aa0ba902b7", &remote_parent.span_id));
    remote_parent.trace_flags = 1;
    remote_parent.remote = true;
    remote_parent.trace_state = "vendor=from-parent";
    o11y_ctx_t *rctx = o11y_ctx_with_span_context(NULL, remote_parent);
    o11y_span_t *from_remote = o11y_tracer_start(tr, rctx, "child.remote", NULL);
    o11y_span_end(from_remote);
    o11y_ctx_destroy(rctx);

    const o11y_test_span_t *sp_remote_child = o11y_test_find_span(rec, "child.remote");
    ASSERT_NOT_NULL(sp_remote_child);
    o11y_span_context_t rparent = o11y_test_span_parent_context(sp_remote_child);
    ASSERT_TRUE(memcmp(remote_parent.span_id.bytes, rparent.span_id.bytes, 8) == 0);
    o11y_span_context_t rsc = o11y_test_span_context(sp_remote_child);
    ASSERT_EQ_STR("vendor=from-parent", rsc.trace_state);

    o11y_test_destroy(rec);
}

static void test_sampler_always_off(void) {
    o11y_test_options_t topts = o11y_test_options_default();
    topts.sampler_kind = O11Y_SAMPLER_ALWAYS_OFF;
    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));

    o11y_tracer_t *tr = o11y_tracer(o11y_test_sdk(rec), "svc");
    o11y_span_t *sp = o11y_tracer_start(tr, NULL, "dropped-span", NULL);
    ASSERT_FALSE(o11y_span_is_recording(sp));
    ASSERT_TRUE(o11y_span_context_is_valid(o11y_span_context(sp)));
    ASSERT_FALSE(o11y_span_context_is_sampled(o11y_span_context(sp)));
    o11y_span_end(sp);

    ASSERT_EQ_SIZE(0, o11y_test_span_count(rec));
    o11y_test_destroy(rec);
}

static void test_id_hex_roundtrip(void) {
    o11y_trace_id_t tid = {0};
    o11y_span_id_t sid = {0};
    ASSERT_TRUE(o11y_trace_id_parse_hex("4bf92f3577b34da6a3ce929d0e0e4736", &tid));
    ASSERT_TRUE(o11y_trace_id_is_valid(tid));
    ASSERT_TRUE(o11y_span_id_parse_hex("00f067aa0ba902b7", &sid));
    ASSERT_TRUE(o11y_span_id_is_valid(sid));

    char tid_hex[33], sid_hex[17];
    o11y_trace_id_hex(tid, tid_hex);
    o11y_span_id_hex(sid, sid_hex);
    ASSERT_EQ_STR("4bf92f3577b34da6a3ce929d0e0e4736", tid_hex);
    ASSERT_EQ_STR("00f067aa0ba902b7", sid_hex);

    /* Reject uppercase hex */
    ASSERT_FALSE(o11y_trace_id_parse_hex("4BF92F3577B34DA6A3CE929D0E0E4736", &tid));
    ASSERT_FALSE(o11y_span_id_parse_hex("00F067AA0BA902B7", &sid));
}

int main(void) {
    RUN_TEST(test_span_hierarchy_and_attributes);
    RUN_TEST(test_sampler_always_off);
    RUN_TEST(test_id_hex_roundtrip);
    TEST_SUMMARY("test_tracing");
}
