#include "o11y/test.h"
#include "test_framework.h"

static const char *APP_REGISTRY_YAML =
    "schema: libo11y.app-registry/v1\n"
    "namespace: acme\n"
    "attributes:\n"
    "  acme.user.email: {type: string, sensitivity: pii, cardinality: unbounded}\n"
    "  acme.api.token: {type: string, sensitivity: secret, cardinality: unbounded}\n"
    "  acme.user.role: {type: string, sensitivity: public, cardinality: enum, values: [admin, member]}\n";

static void test_spec_lookup_tables(void) {
    ASSERT_EQ_INT(O11Y_SENSITIVITY_SECRET, o11y_spec_sensitivity_of("http.request.header.authorization"));
    ASSERT_EQ_INT(O11Y_SENSITIVITY_SECRET, o11y_spec_sensitivity_of("http.request.header.cookie"));
    ASSERT_EQ_INT(O11Y_SENSITIVITY_PII, o11y_spec_sensitivity_of("host.ip"));
    ASSERT_EQ_INT(O11Y_SENSITIVITY_PII, o11y_spec_sensitivity_of(O11Y_ATTR_RUM_ELEMENT_TEXT));
    ASSERT_EQ_INT(O11Y_SENSITIVITY_PUBLIC, o11y_spec_sensitivity_of(O11Y_ATTR_OUTCOME));
    ASSERT_EQ_INT(O11Y_SENSITIVITY_UNCLASSIFIED, o11y_spec_sensitivity_of("acme.unknown.key"));

    ASSERT_EQ_INT(O11Y_CARDINALITY_ENUM, o11y_spec_cardinality_of(O11Y_ATTR_OUTCOME));
    ASSERT_EQ_INT(O11Y_CARDINALITY_UNBOUNDED, o11y_spec_cardinality_of("http.request.header.authorization"));
    ASSERT_EQ_INT(O11Y_CARDINALITY_UNCLASSIFIED, o11y_spec_cardinality_of("acme.unknown.key"));
}

static void test_secret_and_pii_drop_across_signals(void) {
    o11y_app_registry_source_t regs[] = {
        { .file_path = "acme.yaml", .content = APP_REGISTRY_YAML, .content_len = strlen(APP_REGISTRY_YAML) },
    };
    o11y_attr_t res_attrs[] = {
        o11y_kv_str("acme.api.token", "res-secret"),
        o11y_kv_str("acme.user.email", "res@example.com"),
        o11y_kv_str("acme.user.role", "admin"),
    };

    o11y_test_options_t topts = o11y_test_options_default();
    topts.app_registries = regs;
    topts.app_registries_len = 1;
    topts.resource_attributes = res_attrs;
    topts.resource_attributes_len = 3;
    topts.pii_mode = O11Y_PII_DROP;

    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));
    o11y_sdk_t *sdk = o11y_test_sdk(rec);

    /* Span with secret & PII on span attrs, event, and link */
    o11y_tracer_t *tr = o11y_tracer(sdk, "svc");
    o11y_attr_t sp_attrs[] = {
        o11y_kv_str("http.request.header.authorization", "Bearer tok"),
        o11y_kv_str("acme.api.token", "span-secret"),
        o11y_kv_str("acme.user.email", "alice@example.com"),
        o11y_kv_str("acme.user.role", "member"),
    };
    o11y_span_start_options_t sopts = { .attributes = sp_attrs, .attributes_len = 4 };
    o11y_span_t *sp = o11y_tracer_start(tr, NULL, "handle", &sopts);
    o11y_attr_t ev_attrs[] = {
        o11y_kv_str("http.request.header.cookie", "sid=123"),
        o11y_kv_str("safe.key", "ok"),
    };
    o11y_span_add_event(sp, "ev", ev_attrs, 2, 0);
    o11y_span_end(sp);

    /* Log with secret & PII */
    o11y_log_attr_t lattrs[] = {
        o11y_log_kv_str("acme.api.token", "log-secret"),
        o11y_log_kv_str("acme.user.email", "bob@example.com"),
        o11y_log_kv_str("acme.user.role", "admin"),
    };
    o11y_log_info(sdk, NULL, "user action", lattrs, 3);

    /* Metric with secret & PII */
    o11y_counter_i64_t c = o11y_meter_counter_i64(o11y_meter(sdk, "svc"), "acme.actions", NULL);
    o11y_attr_t mattrs[] = {
        o11y_kv_str("acme.api.token", "m-secret"),
        o11y_kv_str("acme.user.email", "m@example.com"),
        o11y_kv_str("acme.user.role", "member"),
    };
    o11y_counter_i64_add(c, NULL, 1, mattrs, 3);

    /* Verify redaction on span & resource */
    const o11y_test_span_t *recorded = o11y_test_find_span(rec, "handle");
    ASSERT_NOT_NULL(recorded);
    ASSERT_NULL(o11y_test_span_resource_attr_str(recorded, "acme.api.token"));
    ASSERT_NULL(o11y_test_span_resource_attr_str(recorded, "acme.user.email"));
    ASSERT_EQ_STR("admin", o11y_test_span_resource_attr_str(recorded, "acme.user.role"));
    ASSERT_FALSE(o11y_test_span_has_attr(recorded, "http.request.header.authorization"));
    ASSERT_FALSE(o11y_test_span_has_attr(recorded, "acme.api.token"));
    ASSERT_FALSE(o11y_test_span_has_attr(recorded, "acme.user.email"));
    ASSERT_EQ_STR("member", o11y_test_span_attr_str(recorded, "acme.user.role"));
    ASSERT_FALSE(o11y_test_span_event_has_attr(recorded, 0, "http.request.header.cookie"));
    ASSERT_EQ_STR("ok", o11y_test_span_event_attr_str(recorded, 0, "safe.key"));

    /* Verify redaction on log */
    const o11y_test_log_t *lr = o11y_test_find_log(rec, "user action");
    ASSERT_NOT_NULL(lr);
    ASSERT_FALSE(o11y_test_log_has_attr(lr, "acme.api.token"));
    ASSERT_FALSE(o11y_test_log_has_attr(lr, "acme.user.email"));
    ASSERT_EQ_STR("admin", o11y_test_log_attr_str(lr, "acme.user.role"));

    /* Verify redaction on metric */
    ASSERT_FALSE(o11y_test_metric_has_attr(rec, "acme.actions", "acme.api.token"));
    ASSERT_FALSE(o11y_test_metric_has_attr(rec, "acme.actions", "acme.user.email"));
    ASSERT_TRUE(o11y_test_metric_has_attr(rec, "acme.actions", "acme.user.role"));

    /* Conformance check MUST fail because secrets were emitted */
    o11y_test_report_t *conf = o11y_test_check_conforms(rec);
    ASSERT_NOT_NULL(conf);
    ASSERT_FALSE(o11y_test_report_ok(conf));
    ASSERT_TRUE(o11y_test_report_count(conf) >= 2);
    o11y_test_report_destroy(conf);

    o11y_test_destroy(rec);
}

static void test_pii_hash_and_allow_modes(void) {
    uint8_t key[32];
    for (size_t i = 0; i < 32; i++) key[i] = (uint8_t)i;

    o11y_app_registry_source_t regs[] = {
        { .file_path = "acme.yaml", .content = APP_REGISTRY_YAML, .content_len = strlen(APP_REGISTRY_YAML) },
    };

    /* HASH mode: logs and spans get deterministic hmac-sha256 token; metrics drop PII */
    o11y_test_options_t topts = o11y_test_options_default();
    topts.app_registries = regs;
    topts.app_registries_len = 1;
    topts.pii_mode = O11Y_PII_HASH;
    topts.pii_hash_key = key;
    topts.pii_hash_key_len = sizeof(key);

    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));
    o11y_sdk_t *sdk = o11y_test_sdk(rec);

    o11y_span_t *sp = o11y_tracer_start(o11y_tracer(sdk, "svc"), NULL, "hashed", NULL);
    o11y_span_set_attr(sp, o11y_kv_str("acme.user.email", "alice@example.com"));
    o11y_span_end(sp);

    o11y_log_attr_t lattrs[] = { o11y_log_kv_str("acme.user.email", "alice@example.com") };
    o11y_log_info(sdk, NULL, "hashed-log", lattrs, 1);

    o11y_counter_i64_t c = o11y_meter_counter_i64(o11y_meter(sdk, "svc"), "acme.logins", NULL);
    o11y_attr_t mattrs[] = { o11y_kv_str("acme.user.email", "alice@example.com") };
    o11y_counter_i64_add(c, NULL, 1, mattrs, 1);

    const char *want_tok = "hmac-sha256:a59fc578d4cb46faab1d6eb348e7c74b";
    ASSERT_EQ_STR(want_tok, o11y_test_span_attr_str(o11y_test_find_span(rec, "hashed"), "acme.user.email"));
    ASSERT_EQ_STR(want_tok, o11y_test_log_attr_str(o11y_test_find_log(rec, "hashed-log"), "acme.user.email"));
    ASSERT_FALSE(o11y_test_metric_has_attr(rec, "acme.logins", "acme.user.email"));
    o11y_test_destroy(rec);

    /* ALLOW mode: PII kept in clear */
    topts = o11y_test_options_default();
    topts.app_registries = regs;
    topts.app_registries_len = 1;
    topts.pii_mode = O11Y_PII_ALLOW;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));
    o11y_log_info(o11y_test_sdk(rec), NULL, "allowed-log", lattrs, 1);
    ASSERT_EQ_STR("alice@example.com", o11y_test_log_attr_str(o11y_test_find_log(rec, "allowed-log"), "acme.user.email"));
    o11y_test_destroy(rec);
}

static void test_invalid_app_registry_fails_init(void) {
    const char *bad_yaml = "schema: libo11y.app-registry/v1\nnamespace: o11y\nattributes:\n  o11y.foo: {type: string, sensitivity: public, cardinality: bounded}\n";
    o11y_app_registry_source_t regs[] = {
        { .file_path = "bad.yaml", .content = bad_yaml, .content_len = strlen(bad_yaml) },
    };
    o11y_test_options_t topts = o11y_test_options_default();
    topts.app_registries = regs;
    topts.app_registries_len = 1;

    o11y_test_recorder_t *rec = NULL;
    o11y_diagnostic_t diag = {0};
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_APP_REGISTRY, o11y_test_start(&topts, &rec, &diag));
    ASSERT_NULL(rec);
    ASSERT_STR_CONTAINS(diag.message, "libo11y_app_namespace_reserved");
}

static void test_out_params_zeroed_nested_bounds_and_violations_signal(void) {
    /* Out-params must be cleared even on early validation failures. */
    uint8_t short_key[4] = { 1, 2, 3, 4 };
    o11y_log_value_t sv = o11y_log_val_str("alice@example.com");
    char *canon = (char *)(uintptr_t)0x1;
    char token[45];
    memset(token, 'Z', sizeof(token));
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_pii_hash_value(NULL, short_key, 4, &canon, token));
    ASSERT_NULL(canon);
    ASSERT_EQ_INT('\0', token[0]);

    canon = (char *)(uintptr_t)0x1;
    memset(token, 'Z', sizeof(token));
    ASSERT_EQ_ERR(O11Y_ERR_PII_HASH_KEY, o11y_pii_hash_value(&sv, short_key, 4, &canon, token));
    ASSERT_NULL(canon);
    ASSERT_EQ_INT('\0', token[0]);

    /* DAG of reused child array (2^20 logical nodes) and cyclic log values must not hang/OOM. */
    uint8_t full_key[32];
    for (size_t i = 0; i < 32; i++) full_key[i] = (uint8_t)i;

    o11y_log_value_t nodes[22][2];
    nodes[0][0] = o11y_log_val_int(1);
    nodes[0][1] = o11y_log_val_int(2);
    for (size_t d = 1; d < 22; d++) {
        o11y_log_value_t child = o11y_log_val_array(nodes[d - 1], 2);
        nodes[d][0] = child;
        nodes[d][1] = child;
    }
    o11y_log_value_t dag_root = o11y_log_val_array(nodes[21], 2);
    ASSERT_EQ_ERR(O11Y_OK, o11y_pii_hash_value(&dag_root, full_key, sizeof(full_key), &canon, token));
    ASSERT_NOT_NULL(canon);
    ASSERT_STR_CONTAINS(canon, "truncated");
    o11y_string_free(canon);

    o11y_log_value_t cyclic[1];
    cyclic[0] = o11y_log_val_array(cyclic, 1);
    ASSERT_EQ_ERR(O11Y_OK, o11y_pii_hash_value(&cyclic[0], full_key, sizeof(full_key), &canon, token));
    ASSERT_NOT_NULL(canon);
    ASSERT_STR_CONTAINS(canon, "truncated");
    o11y_string_free(canon);

    /* Nested map classification + file-backed app registry + test_violations strict signal */
    const char *reg_path = "/tmp/libo11y-c-test-reg.yaml";
    FILE *rf = fopen(reg_path, "wb");
    ASSERT_NOT_NULL(rf);
    ASSERT_TRUE(fwrite(APP_REGISTRY_YAML, 1, strlen(APP_REGISTRY_YAML), rf) == strlen(APP_REGISTRY_YAML));
    fclose(rf);

    o11y_app_registry_source_t file_regs[] = {
        { .file_path = reg_path, .content = NULL, .content_len = 0 },
    };
    o11y_test_options_t topts = o11y_test_options_default();
    topts.app_registries = file_regs;
    topts.app_registries_len = 1;
    topts.pii_mode = O11Y_PII_HASH;
    topts.pii_hash_key = full_key;
    topts.pii_hash_key_len = sizeof(full_key);

    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));
    o11y_sdk_t *sdk = o11y_test_sdk(rec);

    o11y_log_attr_t user_fields[] = {
        o11y_log_kv_str("email", "alice@example.com"),
        o11y_log_kv_str("role", "member"),
    };
    o11y_log_attr_t acme_fields[] = {
        o11y_log_kv_map("user", user_fields, 2),
    };
    o11y_log_attr_t nested_attrs[] = {
        o11y_log_kv_map("acme", acme_fields, 1),
        { .key = "dag", .value = dag_root },
        { .key = "loop", .value = cyclic[0] },
    };
    o11y_log_info(sdk, NULL, "nested-and-bounded", nested_attrs, 3);
    const o11y_test_log_t *lr = o11y_test_find_log(rec, "nested-and-bounded");
    ASSERT_NOT_NULL(lr);
    ASSERT_TRUE(o11y_test_log_has_attr(lr, "acme"));

    /* Typoed signal name must return 0 rather than matching all signals. */
    ASSERT_TRUE(o11y_test_violations(rec, O11Y_SIGNAL_LOGS, "pii_attribute") >= 1);
    ASSERT_EQ_INT(0, o11y_test_violations(rec, "log", NULL));

    /* o11y_test_reset clears recorded logs and console output. */
    o11y_test_reset(rec);
    ASSERT_EQ_SIZE(0, o11y_test_log_count(rec));
    size_t clen = 99;
    ASSERT_EQ_STR("", o11y_test_console_output(rec, &clen));
    ASSERT_EQ_SIZE(0, clen);

    o11y_test_destroy(rec);
    remove(reg_path);
}

int main(void) {
    RUN_TEST(test_spec_lookup_tables);
    RUN_TEST(test_secret_and_pii_drop_across_signals);
    RUN_TEST(test_pii_hash_and_allow_modes);
    RUN_TEST(test_invalid_app_registry_fails_init);
    RUN_TEST(test_out_params_zeroed_nested_bounds_and_violations_signal);
    TEST_SUMMARY("test_sensitivity");
}
