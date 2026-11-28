#include "o11y/test.h"
#include "test_framework.h"

static bool g_sticky_key_setter_ok = false;
static bool g_sticky_val_setter_ok = false;
static bool g_strict_over_budget_rejected = false;
static bool g_strict_null_slice_rejected = false;
static bool g_strict_bad_kind_rejected = false;
static bool g_strict_empty_arr_ok = false;

static bool replacer_rename_and_drop(
    void *userdata,
    const char *const *groups,
    size_t groups_len,
    const char *key,
    const o11y_log_value_t *value,
    o11y_attr_replacement_t *out_replacement) {
    (void)userdata;
    (void)groups;
    (void)groups_len;
    (void)value;
    if (strcmp(key, "drop_me") == 0) {
        return false;
    }
    if (strcmp(key, "alias_secret") == 0) {
        /* Rename to a spec-classified secret key to prove sensitivity runs AFTER replacer */
        (void)o11y_attr_replacement_set_key(out_replacement, "http.request.header.authorization");
        return true;
    }
    if (strcmp(key, "rewrite_val") == 0) {
        char buf[32] = "rewritten";
        o11y_log_value_t sv = o11y_log_val_str(buf);
        (void)o11y_attr_replacement_set_value(out_replacement, &sv);
        memset(buf, 'X', sizeof(buf));
        return true;
    }
    if (strcmp(key, "rewrite_int") == 0) {
        o11y_log_value_t iv = o11y_log_val_int(99);
        (void)o11y_attr_replacement_set_value(out_replacement, &iv);
        return true;
    }
    if (strcmp(key, "rewrite_composite") == 0) {
        char kbuf[32] = "renamed_composite";
        char inner_k[32] = "nested_msg";
        char inner_s[32] = "copied_before_return";
        uint8_t inner_bytes[4] = { 1, 2, 3, 4 };
        o11y_log_value_t arr[2];
        arr[0] = o11y_log_val_str(inner_s);
        arr[1] = o11y_log_val_bytes(inner_bytes, sizeof(inner_bytes));
        o11y_log_attr_t map_items[1] = {
            o11y_log_kv_array(inner_k, arr, 2),
        };
        o11y_log_value_t mv = o11y_log_val_map(map_items, 1);
        o11y_err_t krc = o11y_attr_replacement_set_key(out_replacement, kbuf);
        o11y_err_t vrc = o11y_attr_replacement_set_value(out_replacement, &mv);
        memset(kbuf, 'X', sizeof(kbuf));
        memset(inner_k, 'X', sizeof(inner_k));
        memset(inner_s, 'X', sizeof(inner_s));
        memset(inner_bytes, 'X', sizeof(inner_bytes));
        return krc == O11Y_OK && vrc == O11Y_OK;
    }
    if (strcmp(key, "bad_replacement") == 0) {
        /* Setter failure (NULL value) must fail closed even if callback returns true. */
        (void)o11y_attr_replacement_set_value(out_replacement, NULL);
        return true;
    }
    if (strcmp(key, "sticky_fail") == 0) {
        /* Failed set_key must stay sticky even after a subsequent valid set_key. */
        o11y_err_t e1 = o11y_attr_replacement_set_key(out_replacement, NULL);
        o11y_err_t e2 = o11y_attr_replacement_set_key(out_replacement, "recovered_key");
        g_sticky_key_setter_ok = (e1 == O11Y_ERR_INVALID_ARGUMENT && e2 == O11Y_OK);
        return true;
    }
    if (strcmp(key, "sticky_val_fail") == 0) {
        /* Failed set_value must stay sticky even after a subsequent valid set_value. */
        o11y_err_t e1 = o11y_attr_replacement_set_value(out_replacement, NULL);
        o11y_log_value_t iv = o11y_log_val_int(7);
        o11y_err_t e2 = o11y_attr_replacement_set_value(out_replacement, &iv);
        g_sticky_val_setter_ok = (e1 == O11Y_ERR_INVALID_ARGUMENT && e2 == O11Y_OK);
        return true;
    }
    if (strcmp(key, "over_budget_replacement") == 0) {
        o11y_log_value_t *big = (o11y_log_value_t *)calloc(2050, sizeof(o11y_log_value_t));
        if (big != NULL) {
            for (size_t i = 0; i < 2050; i++) big[i] = o11y_log_val_int((int64_t)i);
            o11y_log_value_t av = o11y_log_val_array(big, 2050);
            o11y_err_t rc = o11y_attr_replacement_set_value(out_replacement, &av);
            g_strict_over_budget_rejected = (rc == O11Y_ERR_INVALID_ARGUMENT);
            free(big);
        }
        return true;
    }
    if (strcmp(key, "null_slice_replacement") == 0) {
        o11y_log_value_t bad_str = { .kind = O11Y_LOG_VAL_STRING, .value.str_val = { .data = NULL, .len = 1, .has_len = true } };
        o11y_log_value_t av = o11y_log_val_array(&bad_str, 1);
        g_strict_null_slice_rejected = (o11y_attr_replacement_set_value(out_replacement, &av) == O11Y_ERR_INVALID_ARGUMENT);
        return true;
    }
    if (strcmp(key, "bad_kind_replacement") == 0) {
        o11y_log_value_t bad_kind = { .kind = (o11y_log_value_kind_t)99 };
        g_strict_bad_kind_rejected = (o11y_attr_replacement_set_value(out_replacement, &bad_kind) == O11Y_ERR_INVALID_ARGUMENT);
        return true;
    }
    if (strcmp(key, "empty_array_replacement") == 0) {
        o11y_log_value_t empty_arr = o11y_log_val_array(NULL, 0);
        g_strict_empty_arr_ok = (o11y_attr_replacement_set_value(out_replacement, &empty_arr) == O11Y_OK);
        return true;
    }
    return true;
}

static o11y_err_t failing_console_writer(void *userdata, const uint8_t *bytes, size_t len) {
    (void)userdata;
    (void)bytes;
    (void)len;
    return O11Y_ERR_IO;
}

struct sink_capture {
    int count;
    char last_msg[128];
};

static bool extra_sink_enabled(void *userdata, o11y_level_t level, bool force_emit) {
    (void)userdata;
    return force_emit || level >= O11Y_LEVEL_INFO;
}

static o11y_err_t extra_sink_emit(
    void *userdata,
    uint64_t time_unix_nano,
    o11y_level_t level,
    const char *message,
    o11y_span_context_t span_context,
    const o11y_log_attr_t *attrs,
    size_t attrs_len) {
    (void)time_unix_nano;
    (void)level;
    (void)span_context;
    (void)attrs;
    (void)attrs_len;
    struct sink_capture *cap = (struct sink_capture *)userdata;
    cap->count++;
    snprintf(cap->last_msg, sizeof(cap->last_msg), "%s", message);
    return O11Y_OK;
}

static void test_logging_correlation_force_emit_and_console(void) {
    struct sink_capture cap = {0};
    o11y_log_sink_t sinks[] = {
        { .userdata = &cap, .enabled = extra_sink_enabled, .emit = extra_sink_emit },
    };

    o11y_test_options_t topts = o11y_test_options_default();
    topts.log_level = O11Y_LEVEL_WARN;
    topts.extra_log_sinks = sinks;
    topts.extra_log_sinks_len = 1;
    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));

    o11y_sdk_t *sdk = o11y_test_sdk(rec);
    o11y_span_t *sp = o11y_tracer_start(o11y_tracer(sdk, "svc"), NULL, "work", NULL);
    o11y_span_context_t sc = o11y_span_context(sp);
    char want_tid[33], want_sid[17];
    o11y_trace_id_hex(sc.trace_id, want_tid);
    o11y_span_id_hex(sc.span_id, want_sid);

    o11y_ctx_t *ctx = o11y_ctx_with_span(NULL, sp);

    /* INFO is gated out at WARN level */
    o11y_log_info(sdk, ctx, "dropped-info", NULL, 0);
    ASSERT_NULL(o11y_test_find_log(rec, "dropped-info"));

    /* ForceEmit bypasses level gate; caller trace_id spoofing is stripped */
    o11y_ctx_t *forced = o11y_ctx_with_force_emit(ctx);
    o11y_log_attr_t attrs[] = {
        o11y_log_kv_str("trace_id", "spoofed"),
        o11y_log_kv_str(O11Y_ATTR_RECORD_CLASS, O11Y_RECORD_CLASS_AUDIT),
    };
    o11y_log_debug(sdk, forced, "audit-forced", attrs, 2);

    const o11y_test_log_t *lr = o11y_test_find_log(rec, "audit-forced");
    ASSERT_NOT_NULL(lr);
    ASSERT_EQ_INT(O11Y_LEVEL_DEBUG, o11y_test_log_level(lr));
    ASSERT_EQ_STR(want_tid, o11y_test_log_attr_str(lr, "trace_id"));
    ASSERT_EQ_STR(want_sid, o11y_test_log_attr_str(lr, "span_id"));
    ASSERT_EQ_STR("audit", o11y_test_log_attr_str(lr, O11Y_ATTR_RECORD_CLASS));

    /* Console JSON output carries trace_id and span_id */
    size_t clen = 0;
    const char *console = o11y_test_console_output(rec, &clen);
    ASSERT_TRUE(clen > 0);
    ASSERT_STR_CONTAINS(console, want_tid);
    ASSERT_STR_CONTAINS(console, want_sid);
    ASSERT_STR_CONTAINS(console, "audit-forced");

    /* Extra sink and OTLP log leg also received the record */
    ASSERT_EQ_INT(1, cap.count);
    ASSERT_EQ_STR("audit-forced", cap.last_msg);
    ASSERT_TRUE(o11y_test_otlp_log_count(rec) >= 1);

    o11y_ctx_destroy(forced);
    o11y_ctx_destroy(ctx);
    o11y_span_end(sp);
    o11y_test_destroy(rec);
}

static void test_attr_replacer_runs_before_sensitivity(void) {
    g_sticky_key_setter_ok = false;
    g_sticky_val_setter_ok = false;
    g_strict_over_budget_rejected = false;
    g_strict_null_slice_rejected = false;
    g_strict_bad_kind_rejected = false;
    g_strict_empty_arr_ok = false;
    o11y_test_options_t topts = o11y_test_options_default();
    topts.attr_replacer_fn = replacer_rename_and_drop;
    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));

    o11y_log_attr_t attrs[] = {
        o11y_log_kv_str("drop_me", "gone"),
        o11y_log_kv_str("alias_secret", "Bearer top-secret"),
        o11y_log_kv_str("rewrite_val", "original"),
        o11y_log_kv_str("rewrite_int", "raw"),
        o11y_log_kv_str("rewrite_composite", "orig"),
        o11y_log_kv_str("bad_replacement", "should-drop"),
        o11y_log_kv_str("sticky_fail", "should-drop"),
        o11y_log_kv_str("sticky_val_fail", "should-drop"),
        o11y_log_kv_str("over_budget_replacement", "should-drop"),
        o11y_log_kv_str("null_slice_replacement", "should-drop"),
        o11y_log_kv_str("bad_kind_replacement", "should-drop"),
        o11y_log_kv_str("empty_array_replacement", "replaced-with-empty"),
    };
    o11y_log_info(o11y_test_sdk(rec), NULL, "replaced", attrs, 12);

    const o11y_test_log_t *lr = o11y_test_find_log(rec, "replaced");
    ASSERT_NOT_NULL(lr);
    ASSERT_TRUE(g_sticky_key_setter_ok);
    ASSERT_TRUE(g_sticky_val_setter_ok);
    ASSERT_TRUE(g_strict_over_budget_rejected);
    ASSERT_TRUE(g_strict_null_slice_rejected);
    ASSERT_TRUE(g_strict_bad_kind_rejected);
    ASSERT_TRUE(g_strict_empty_arr_ok);
    ASSERT_FALSE(o11y_test_log_has_attr(lr, "drop_me"));
    ASSERT_FALSE(o11y_test_log_has_attr(lr, "alias_secret"));
    ASSERT_FALSE(o11y_test_log_has_attr(lr, "http.request.header.authorization"));
    ASSERT_FALSE(o11y_test_log_has_attr(lr, "bad_replacement"));
    ASSERT_FALSE(o11y_test_log_has_attr(lr, "sticky_fail"));
    ASSERT_FALSE(o11y_test_log_has_attr(lr, "recovered_key"));
    ASSERT_FALSE(o11y_test_log_has_attr(lr, "sticky_val_fail"));
    ASSERT_FALSE(o11y_test_log_has_attr(lr, "over_budget_replacement"));
    ASSERT_FALSE(o11y_test_log_has_attr(lr, "null_slice_replacement"));
    ASSERT_FALSE(o11y_test_log_has_attr(lr, "bad_kind_replacement"));
    ASSERT_TRUE(o11y_test_log_has_attr(lr, "empty_array_replacement"));
    ASSERT_EQ_STR("rewritten", o11y_test_log_attr_str(lr, "rewrite_val"));
    int64_t replaced_int = 0;
    ASSERT_TRUE(o11y_test_log_attr_int(lr, "rewrite_int", &replaced_int));
    ASSERT_EQ_INT(99, replaced_int);
    ASSERT_TRUE(o11y_test_log_has_attr(lr, "renamed_composite"));
    const char *console = o11y_test_console_output(rec, NULL);
    ASSERT_STR_CONTAINS(console, "renamed_composite");
    ASSERT_STR_CONTAINS(console, "nested_msg");
    ASSERT_STR_CONTAINS(console, "copied_before_return");
    ASSERT_TRUE(strstr(console, "XXXX") == NULL);
    ASSERT_TRUE(o11y_test_violations(rec, O11Y_SIGNAL_LOGS, "secret_attribute") >= 1);

    o11y_test_destroy(rec);
}

static void test_canary_rejection_fails_setup(void) {
    o11y_options_t opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_HERMETIC;
    opts.service_name = "canary-svc";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    opts.console_enabled = true;
    opts.console_target = O11Y_CONSOLE_CUSTOM;
    opts.console_write_fn = failing_console_writer;
    opts.runtime_metrics = false;

    o11y_sdk_t *sdk = NULL;
    o11y_diagnostic_t diag = {0};
    ASSERT_EQ_ERR(O11Y_ERR_CANARY_REJECTED, o11y_setup(&opts, &sdk, &diag));
    ASSERT_NULL(sdk);
    ASSERT_TRUE(diag.len > 0);
}

static void test_wide_event_record_and_capture_redaction(void) {
    o11y_test_options_t topts = o11y_test_options_default();
    topts.log_level = O11Y_LEVEL_ERROR; /* events bypass level gates */
    o11y_test_recorder_t *rec_test = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec_test, NULL));
    o11y_sdk_t *sdk = o11y_test_sdk(rec_test);

    o11y_record_t *wide = o11y_record_create();
    ASSERT_NOT_NULL(wide);
    o11y_ctx_t *ctx = o11y_ctx_with_record(NULL, wide);
    ASSERT_TRUE(o11y_ctx_record(ctx) == wide);

    o11y_record_set(wide, o11y_log_kv_str("http.route", "/checkout"));
    o11y_record_add(wide, "db.queries", 2);
    o11y_record_add(wide, "db.queries", 3);
    o11y_record_max(wide, "downstream.max_ms", 10.5);
    o11y_record_max(wide, "downstream.max_ms", 4.0);
    o11y_record_max(wide, "downstream.max_ms", 22.75);
    o11y_record_set_error(wide, "UpstreamTimeout");

    o11y_log_attr_t extra[] = {
        o11y_log_kv_double(O11Y_ATTR_DURATION, 0.25),
    };
    o11y_record_emit_event(wide, ctx, sdk, O11Y_EVENT_REQUEST_SUMMARY, extra, 1);

    const o11y_test_log_t *ev = o11y_test_find_event(rec_test, O11Y_EVENT_REQUEST_SUMMARY);
    ASSERT_NOT_NULL(ev);
    ASSERT_EQ_STR("/checkout", o11y_test_log_attr_str(ev, "http.route"));
    int64_t queries = 0;
    ASSERT_TRUE(o11y_test_log_attr_int(ev, "db.queries", &queries));
    ASSERT_EQ_INT(5, queries);
    double max_ms = 0.0;
    ASSERT_TRUE(o11y_test_log_attr_double(ev, "downstream.max_ms", &max_ms));
    ASSERT_EQ_DBL(22.75, max_ms, 1e-6);
    ASSERT_EQ_STR("UpstreamTimeout", o11y_test_log_attr_str(ev, "error.type"));
    ASSERT_EQ_STR("failure", o11y_test_log_attr_str(ev, O11Y_ATTR_OUTCOME));

    /* Capture-time redaction helpers */
    ASSERT_EQ_STR("REDACTED", o11y_redact_secret());
    char masked[32];
    /* "caf\xc3\xa9" is 4 UTF-8 runes (5 bytes) */
    size_t runes = o11y_redact_mask("caf\xc3\xa9", 5, masked, sizeof(masked));
    ASSERT_EQ_SIZE(4, runes);
    ASSERT_EQ_STR("XXXX", masked);

    /* A short buffer truncates the mask and still reports the full length. */
    char small[3];
    ASSERT_EQ_SIZE(4, o11y_redact_mask("caf\xc3\xa9", 5, small, sizeof(small)));
    ASSERT_EQ_STR("XX", small);
    ASSERT_EQ_SIZE(4, o11y_redact_mask("caf\xc3\xa9", 5, NULL, 0));

    /* The masked and secret attributes reach the sinks already redacted. */
    char card_mask[32];
    o11y_log_attr_t redacted[] = {
        o11y_log_kv_masked("card.last4", "4242", card_mask, sizeof(card_mask)),
        o11y_log_kv_secret("card.cvv"),
    };
    o11y_log_error(sdk, NULL, "card charged", redacted, 2); /* the recorder gates below ERROR */
    const o11y_test_log_t *charged = o11y_test_find_log(rec_test, "card charged");
    ASSERT_NOT_NULL(charged);
    ASSERT_EQ_STR("XXXX", o11y_test_log_attr_str(charged, "card.last4"));
    ASSERT_EQ_STR("REDACTED", o11y_test_log_attr_str(charged, "card.cvv"));
    ASSERT_TRUE(strstr(o11y_test_console_output(rec_test, NULL), "4242") == NULL);

    o11y_ctx_destroy(ctx);
    o11y_record_destroy(wide);
    o11y_test_destroy(rec_test);

    /* Text console format writes readable KEY=VALUE text output. */
    o11y_test_options_t text_opts = o11y_test_options_default();
    text_opts.console_format = O11Y_CONSOLE_TEXT;
    o11y_test_recorder_t *text_rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&text_opts, &text_rec, NULL));
    o11y_log_attr_t text_attrs[] = { o11y_log_kv_str("order.id", "ord-9") };
    o11y_log_info(o11y_test_sdk(text_rec), NULL, "text-line", text_attrs, 1);
    size_t text_len = 0;
    const char *text_out = o11y_test_console_output(text_rec, &text_len);
    ASSERT_TRUE(text_len > 0);
    ASSERT_STR_CONTAINS(text_out, "text-line");
    ASSERT_STR_CONTAINS(text_out, "order.id=ord-9");
    o11y_test_destroy(text_rec);
}

int main(void) {
    RUN_TEST(test_logging_correlation_force_emit_and_console);
    RUN_TEST(test_attr_replacer_runs_before_sensitivity);
    RUN_TEST(test_canary_rejection_fails_setup);
    RUN_TEST(test_wide_event_record_and_capture_redaction);
    TEST_SUMMARY("test_logging");
}
