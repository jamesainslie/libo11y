/*
 * Cross-language conformance suite executed directly through the C11 ABI.
 *
 * Verifies byte-for-byte agreement with Go/TS/Rust/Zig against:
 *   - conformance/vectors/instance-id.json
 *   - conformance/vectors/endpoint-sanitize.json
 *   - conformance/vectors/pii-hash.json
 *   - every *.yaml / *.want pair in conformance/appregistry/
 */

#define _POSIX_C_SOURCE 200809L

#include <ctype.h>
#include <dirent.h>
#include <errno.h>

#include "o11y/o11y.h"
#include "test_framework.h"

static const char *g_conformance_dir = "../conformance";

static char *read_file_all(const char *path, size_t *out_len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return NULL;
    }
    long sz = ftell(f);
    if (sz < 0) {
        fclose(f);
        return NULL;
    }
    rewind(f);
    char *buf = (char *)malloc((size_t)sz + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    size_t n = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[n] = '\0';
    if (out_len) *out_len = n;
    return buf;
}

/* =========================================================================
 * Minimal strict JSON DOM parser (supports UTF-8, \uXXXX + surrogate pairs)
 * ========================================================================= */

typedef enum jkind { J_NULL, J_BOOL, J_INT, J_FLOAT, J_STR, J_ARR, J_OBJ } jkind_t;

typedef struct jval jval_t;
typedef struct jpair {
    char *key;
    jval_t *val;
} jpair_t;

struct jval {
    jkind_t kind;
    bool b;
    int64_t i;
    double d;
    char *s;
    size_t slen;
    jval_t **items;
    jpair_t *pairs;
    size_t len;
};

static void jval_free(jval_t *v) {
    if (!v) return;
    if (v->kind == J_STR) free(v->s);
    if (v->kind == J_ARR) {
        for (size_t i = 0; i < v->len; i++) jval_free(v->items[i]);
        free(v->items);
    }
    if (v->kind == J_OBJ) {
        for (size_t i = 0; i < v->len; i++) {
            free(v->pairs[i].key);
            jval_free(v->pairs[i].val);
        }
        free(v->pairs);
    }
    free(v);
}

static const jval_t *jobj_get(const jval_t *obj, const char *key) {
    if (!obj || obj->kind != J_OBJ) return NULL;
    for (size_t i = 0; i < obj->len; i++) {
        if (strcmp(obj->pairs[i].key, key) == 0) return obj->pairs[i].val;
    }
    return NULL;
}

struct jparser {
    const char *p;
    const char *end;
};

static void skip_ws(struct jparser *jp) {
    while (jp->p < jp->end && (*jp->p == ' ' || *jp->p == '\t' || *jp->p == '\n' || *jp->p == '\r')) {
        jp->p++;
    }
}

static int hex_val(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static bool parse_u4(struct jparser *jp, uint32_t *out) {
    if (jp->end - jp->p < 4) return false;
    uint32_t v = 0;
    for (int i = 0; i < 4; i++) {
        int h = hex_val(jp->p[i]);
        if (h < 0) return false;
        v = (v << 4) | (uint32_t)h;
    }
    jp->p += 4;
    *out = v;
    return true;
}

static void append_utf8(char **buf, size_t *len, size_t *cap, uint32_t cp) {
    if (*len + 5 > *cap) {
        *cap = (*cap == 0) ? 64 : (*cap * 2);
        *buf = (char *)realloc(*buf, *cap);
    }
    if (cp < 0x80) {
        (*buf)[(*len)++] = (char)cp;
    } else if (cp < 0x800) {
        (*buf)[(*len)++] = (char)(0xC0 | (cp >> 6));
        (*buf)[(*len)++] = (char)(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
        (*buf)[(*len)++] = (char)(0xE0 | (cp >> 12));
        (*buf)[(*len)++] = (char)(0x80 | ((cp >> 6) & 0x3F));
        (*buf)[(*len)++] = (char)(0x80 | (cp & 0x3F));
    } else {
        (*buf)[(*len)++] = (char)(0xF0 | (cp >> 18));
        (*buf)[(*len)++] = (char)(0x80 | ((cp >> 12) & 0x3F));
        (*buf)[(*len)++] = (char)(0x80 | ((cp >> 6) & 0x3F));
        (*buf)[(*len)++] = (char)(0x80 | (cp & 0x3F));
    }
}

static char *parse_jstr(struct jparser *jp, size_t *out_len) {
    if (jp->p >= jp->end || *jp->p != '"') return NULL;
    jp->p++;
    char *buf = NULL;
    size_t len = 0, cap = 0;
    while (jp->p < jp->end) {
        unsigned char c = (unsigned char)*jp->p++;
        if (c == '"') {
            if (len + 1 > cap) {
                cap = len + 1;
                buf = (char *)realloc(buf, cap);
            }
            buf[len] = '\0';
            if (out_len) *out_len = len;
            return buf;
        }
        if (c == '\\') {
            if (jp->p >= jp->end) { free(buf); return NULL; }
            char e = *jp->p++;
            uint32_t cp = 0;
            switch (e) {
                case '"': cp = '"'; break;
                case '\\': cp = '\\'; break;
                case '/': cp = '/'; break;
                case 'b': cp = '\b'; break;
                case 'f': cp = '\f'; break;
                case 'n': cp = '\n'; break;
                case 'r': cp = '\r'; break;
                case 't': cp = '\t'; break;
                case 'u': {
                    if (!parse_u4(jp, &cp)) { free(buf); return NULL; }
                    if (cp >= 0xD800 && cp <= 0xDBFF && jp->end - jp->p >= 6 && jp->p[0] == '\\' && jp->p[1] == 'u') {
                        jp->p += 2;
                        uint32_t lo = 0;
                        if (!parse_u4(jp, &lo)) { free(buf); return NULL; }
                        cp = 0x10000 + (((cp - 0xD800) << 10) | (lo - 0xDC00));
                    }
                    break;
                }
                default: free(buf); return NULL;
            }
            append_utf8(&buf, &len, &cap, cp);
        } else {
            if (len + 2 > cap) {
                cap = (cap == 0) ? 64 : (cap * 2);
                buf = (char *)realloc(buf, cap);
            }
            buf[len++] = (char)c;
        }
    }
    free(buf);
    return NULL;
}

static jval_t *parse_jval(struct jparser *jp);

static jval_t *parse_jval(struct jparser *jp) {
    skip_ws(jp);
    if (jp->p >= jp->end) return NULL;
    char c = *jp->p;
    jval_t *v = (jval_t *)calloc(1, sizeof(jval_t));
    if (!v) return NULL;

    if (c == '"') {
        v->kind = J_STR;
        v->s = parse_jstr(jp, &v->slen);
        if (!v->s) { free(v); return NULL; }
        return v;
    }
    if (c == '{') {
        v->kind = J_OBJ;
        jp->p++;
        skip_ws(jp);
        if (jp->p < jp->end && *jp->p == '}') { jp->p++; return v; }
        size_t cap = 0;
        while (jp->p < jp->end) {
            skip_ws(jp);
            char *k = parse_jstr(jp, NULL);
            if (!k) { jval_free(v); return NULL; }
            skip_ws(jp);
            if (jp->p >= jp->end || *jp->p != ':') { free(k); jval_free(v); return NULL; }
            jp->p++;
            jval_t *val = parse_jval(jp);
            if (!val) { free(k); jval_free(v); return NULL; }
            if (v->len == cap) {
                cap = cap ? cap * 2 : 8;
                v->pairs = (jpair_t *)realloc(v->pairs, cap * sizeof(jpair_t));
            }
            v->pairs[v->len].key = k;
            v->pairs[v->len].val = val;
            v->len++;
            skip_ws(jp);
            if (jp->p < jp->end && *jp->p == ',') { jp->p++; continue; }
            if (jp->p < jp->end && *jp->p == '}') { jp->p++; return v; }
            jval_free(v);
            return NULL;
        }
        jval_free(v);
        return NULL;
    }
    if (c == '[') {
        v->kind = J_ARR;
        jp->p++;
        skip_ws(jp);
        if (jp->p < jp->end && *jp->p == ']') { jp->p++; return v; }
        size_t cap = 0;
        while (jp->p < jp->end) {
            jval_t *item = parse_jval(jp);
            if (!item) { jval_free(v); return NULL; }
            if (v->len == cap) {
                cap = cap ? cap * 2 : 8;
                v->items = (jval_t **)realloc(v->items, cap * sizeof(jval_t *));
            }
            v->items[v->len++] = item;
            skip_ws(jp);
            if (jp->p < jp->end && *jp->p == ',') { jp->p++; continue; }
            if (jp->p < jp->end && *jp->p == ']') { jp->p++; return v; }
            jval_free(v);
            return NULL;
        }
        jval_free(v);
        return NULL;
    }
    if (jp->end - jp->p >= 4 && memcmp(jp->p, "true", 4) == 0) {
        v->kind = J_BOOL; v->b = true; jp->p += 4; return v;
    }
    if (jp->end - jp->p >= 5 && memcmp(jp->p, "false", 5) == 0) {
        v->kind = J_BOOL; v->b = false; jp->p += 5; return v;
    }
    if (jp->end - jp->p >= 4 && memcmp(jp->p, "null", 4) == 0) {
        v->kind = J_NULL; jp->p += 4; return v;
    }
    /* Number */
    const char *start = jp->p;
    bool is_float = false;
    if (*jp->p == '-') jp->p++;
    while (jp->p < jp->end && isdigit((unsigned char)*jp->p)) jp->p++;
    if (jp->p < jp->end && *jp->p == '.') {
        is_float = true;
        jp->p++;
        while (jp->p < jp->end && isdigit((unsigned char)*jp->p)) jp->p++;
    }
    if (jp->p < jp->end && (*jp->p == 'e' || *jp->p == 'E')) {
        is_float = true;
        jp->p++;
        if (jp->p < jp->end && (*jp->p == '+' || *jp->p == '-')) jp->p++;
        while (jp->p < jp->end && isdigit((unsigned char)*jp->p)) jp->p++;
    }
    if (jp->p == start) { free(v); return NULL; }
    char numbuf[128];
    size_t nlen = (size_t)(jp->p - start);
    if (nlen >= sizeof(numbuf)) { free(v); return NULL; }
    memcpy(numbuf, start, nlen);
    numbuf[nlen] = '\0';
    if (is_float) {
        v->kind = J_FLOAT;
        v->d = strtod(numbuf, NULL);
    } else {
        v->kind = J_INT;
        v->i = strtoll(numbuf, NULL, 10);
        v->d = (double)v->i;
    }
    return v;
}

static jval_t *parse_json_file(const char *path) {
    size_t len = 0;
    char *raw = read_file_all(path, &len);
    if (!raw) return NULL;
    struct jparser jp = { .p = raw, .end = raw + len };
    jval_t *v = parse_jval(&jp);
    free(raw);
    return v;
}

/* =========================================================================
 * Base64 decoder (for pii-hash.json `bytes` cases)
 * ========================================================================= */

static int b64_val(unsigned char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

static uint8_t *b64_decode(const char *s, size_t slen, size_t *out_len) {
    uint8_t *out = (uint8_t *)malloc(slen + 4);
    size_t n = 0;
    uint32_t acc = 0;
    int bits = 0;
    for (size_t i = 0; i < slen; i++) {
        if (s[i] == '=') break;
        int v = b64_val((unsigned char)s[i]);
        if (v < 0) continue;
        acc = (acc << 6) | (uint32_t)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[n++] = (uint8_t)((acc >> bits) & 0xFF);
        }
    }
    *out_len = n;
    return out;
}

/* Convert parsed JSON value into o11y_log_value_t (allocating child arrays/maps in a simple list to free). */
struct alloc_pool {
    void **ptrs;
    size_t len;
    size_t cap;
};

static void *pool_alloc(struct alloc_pool *p, size_t sz) {
    void *m = calloc(1, sz ? sz : 1);
    if (p->len == p->cap) {
        p->cap = p->cap ? p->cap * 2 : 32;
        p->ptrs = (void **)realloc(p->ptrs, p->cap * sizeof(void *));
    }
    p->ptrs[p->len++] = m;
    return m;
}

static void pool_free(struct alloc_pool *p) {
    for (size_t i = 0; i < p->len; i++) free(p->ptrs[i]);
    free(p->ptrs);
}

static o11y_log_value_t jval_to_log_value(const jval_t *v, const char *force_kind, struct alloc_pool *pool) {
    if (force_kind && strcmp(force_kind, "bytes") == 0 && v->kind == J_STR) {
        size_t blen = 0;
        uint8_t *decoded = b64_decode(v->s, v->slen, &blen);
        uint8_t *copy = (uint8_t *)pool_alloc(pool, blen);
        if (blen > 0) memcpy(copy, decoded, blen);
        free(decoded);
        return o11y_log_val_bytes(copy, blen);
    }
    if (force_kind && strcmp(force_kind, "float") == 0) {
        double d = (v->kind == J_FLOAT) ? v->d : (double)v->i;
        return o11y_log_val_double(d);
    }
    if (force_kind && strcmp(force_kind, "float_array") == 0 && v->kind == J_ARR) {
        o11y_log_value_t *items = (o11y_log_value_t *)pool_alloc(pool, v->len * sizeof(o11y_log_value_t));
        for (size_t i = 0; i < v->len; i++) {
            double d = (v->items[i]->kind == J_FLOAT) ? v->items[i]->d : (double)v->items[i]->i;
            items[i] = o11y_log_val_double(d);
        }
        return o11y_log_val_array(items, v->len);
    }
    switch (v->kind) {
        case J_NULL: return o11y_log_val_empty();
        case J_BOOL: return o11y_log_val_bool(v->b);
        case J_INT: return o11y_log_val_int(v->i);
        case J_FLOAT: return o11y_log_val_double(v->d);
        case J_STR: return o11y_log_val_strn(v->s, v->slen);
        case J_ARR: {
            o11y_log_value_t *items = (o11y_log_value_t *)pool_alloc(pool, v->len * sizeof(o11y_log_value_t));
            for (size_t i = 0; i < v->len; i++) {
                items[i] = jval_to_log_value(v->items[i], NULL, pool);
            }
            return o11y_log_val_array(items, v->len);
        }
        case J_OBJ: {
            o11y_log_attr_t *items = (o11y_log_attr_t *)pool_alloc(pool, v->len * sizeof(o11y_log_attr_t));
            for (size_t i = 0; i < v->len; i++) {
                items[i].key = v->pairs[i].key;
                items[i].value = jval_to_log_value(v->pairs[i].val, NULL, pool);
            }
            return o11y_log_val_map(items, v->len);
        }
    }
    return o11y_log_val_empty();
}

/* =========================================================================
 * Conformance Tests
 * ========================================================================= */

static void test_conformance_instance_id(void) {
    char path[512];
    snprintf(path, sizeof(path), "%s/vectors/instance-id.json", g_conformance_dir);
    jval_t *root = parse_json_file(path);
    ASSERT_NOT_NULL(root);
    ASSERT_EQ_INT(J_ARR, root->kind);
    ASSERT_TRUE(root->len > 0);

    for (size_t i = 0; i < root->len; i++) {
        const jval_t *tc = root->items[i];
        const char *uid = jobj_get(tc, "k8s_pod_uid")->s;
        const char *pod = jobj_get(tc, "k8s_pod_name")->s;
        const char *ns = jobj_get(tc, "k8s_namespace_name")->s;
        const char *want = jobj_get(tc, "want")->s;

        char got[37] = {0};
        ASSERT_TRUE(o11y_derive_instance_id(uid, pod, ns, got));
        ASSERT_EQ_STR(want, got);
    }
    jval_free(root);
}

static void test_conformance_endpoint_sanitize(void) {
    char path[512];
    snprintf(path, sizeof(path), "%s/vectors/endpoint-sanitize.json", g_conformance_dir);
    jval_t *root = parse_json_file(path);
    ASSERT_NOT_NULL(root);
    ASSERT_EQ_INT(J_ARR, root->kind);
    ASSERT_TRUE(root->len > 0);

    for (size_t i = 0; i < root->len; i++) {
        const jval_t *tc = root->items[i];
        const jval_t *in_v = jobj_get(tc, "in");
        const char *want = jobj_get(tc, "want")->s;

        char *got = NULL;
        ASSERT_EQ_ERR(O11Y_OK, o11y_sanitize_endpoint(in_v->s, in_v->slen, &got));
        ASSERT_EQ_STR(want, got);
        o11y_string_free(got);
    }
    jval_free(root);
}

static void test_conformance_pii_hash(void) {
    char path[512];
    snprintf(path, sizeof(path), "%s/vectors/pii-hash.json", g_conformance_dir);
    jval_t *root = parse_json_file(path);
    ASSERT_NOT_NULL(root);

    const char *key_hex = jobj_get(root, "key_hex")->s;
    uint8_t key[32];
    for (size_t i = 0; i < 32; i++) {
        key[i] = (uint8_t)((hex_val(key_hex[2 * i]) << 4) | hex_val(key_hex[2 * i + 1]));
    }

    const jval_t *cases = jobj_get(root, "cases");
    ASSERT_NOT_NULL(cases);
    ASSERT_TRUE(cases->len > 0);

    for (size_t i = 0; i < cases->len; i++) {
        const jval_t *tc = cases->items[i];
        const char *name = jobj_get(tc, "name")->s;
        const char *kind = jobj_get(tc, "kind")->s;
        const jval_t *val = jobj_get(tc, "value");
        const char *want_canon = jobj_get(tc, "canonical")->s;
        const char *want_tok = jobj_get(tc, "token")->s;

        struct alloc_pool pool = {0};
        o11y_log_value_t lv = jval_to_log_value(val, kind, &pool);

        char *got_canon = NULL;
        char got_tok[45] = {0};
        o11y_err_t rc = o11y_pii_hash_value(&lv, key, sizeof(key), &got_canon, got_tok);
        if (rc != O11Y_OK || strcmp(want_canon, got_canon) != 0 || strcmp(want_tok, got_tok) != 0) {
            fprintf(stderr, "  FAIL pii-hash case \"%s\": rc=%s canon=%s want=%s tok=%s want_tok=%s\n",
                    name, o11y_err_name(rc), got_canon ? got_canon : "(null)", want_canon, got_tok, want_tok);
            o11y_string_free(got_canon);
            pool_free(&pool);
            jval_free(root);
            g_tests_failed++;
            return;
        }
        o11y_string_free(got_canon);
        pool_free(&pool);
    }
    jval_free(root);
}

static void test_conformance_app_registry_cases(void) {
    char dir_path[512];
    snprintf(dir_path, sizeof(dir_path), "%s/appregistry", g_conformance_dir);
    DIR *d = opendir(dir_path);
    ASSERT_NOT_NULL(d);

    size_t checked = 0;
    struct dirent *ent;
    while ((ent = readdir(d)) != NULL) {
        size_t nlen = strlen(ent->d_name);
        if (nlen <= 5 || strcmp(ent->d_name + nlen - 5, ".yaml") != 0) continue;

        char yaml_path[768], want_path[768];
        snprintf(yaml_path, sizeof(yaml_path), "%s/%s", dir_path, ent->d_name);
        snprintf(want_path, sizeof(want_path), "%s/%.*s.want", dir_path, (int)(nlen - 5), ent->d_name);

        size_t yaml_len = 0, want_len = 0;
        char *yaml = read_file_all(yaml_path, &yaml_len);
        char *want = read_file_all(want_path, &want_len);
        ASSERT_NOT_NULL(yaml);
        ASSERT_NOT_NULL(want);

        /* Trim trailing newline on .want */
        while (want_len > 0 && (want[want_len - 1] == '\n' || want[want_len - 1] == '\r')) {
            want[--want_len] = '\0';
        }

        int want_status = 1;
        if (strncmp(want, "ok ", 3) == 0) {
            want_status = 0;
        } else if (strncmp(want, "parse:", 6) == 0) {
            want_status = 2;
        }

        char *got = NULL;
        int status = -1;
        o11y_err_t rc = o11y_app_registry_check_bytes(yaml, yaml_len, &got, &status);
        if (rc != O11Y_OK || got == NULL || strcmp(want, got) != 0 || status != want_status) {
            fprintf(stderr, "  FAIL appregistry case %s:\n    want (status=%d): %s\n    got  (status=%d): %s\n",
                    ent->d_name, want_status, want, status, got ? got : "(null)");
            o11y_string_free(got);
            free(yaml);
            free(want);
            closedir(d);
            g_tests_failed++;
            return;
        }
        o11y_string_free(got);
        free(yaml);
        free(want);
        checked++;
    }
    closedir(d);
    ASSERT_TRUE(checked >= 40);
    printf("    verified %zu appregistry conformance cases\n", checked);
}

int main(int argc, char **argv) {
    if (argc > 1 && argv[1][0] != '\0') {
        g_conformance_dir = argv[1];
    }
    RUN_TEST(test_conformance_instance_id);
    RUN_TEST(test_conformance_endpoint_sanitize);
    RUN_TEST(test_conformance_pii_hash);
    RUN_TEST(test_conformance_app_registry_cases);
    TEST_SUMMARY("test_conformance");
}
