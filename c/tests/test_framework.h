#ifndef O11Y_TEST_FRAMEWORK_H
#define O11Y_TEST_FRAMEWORK_H

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int g_tests_run = 0;
static int g_tests_failed = 0;

#define FAIL_MSG(fmt, ...) do { \
    fprintf(stderr, "  FAIL %s:%d: " fmt "\n", __FILE__, __LINE__, __VA_ARGS__); \
    g_tests_failed++; \
    return; \
} while (0)

#define ASSERT_TRUE(cond) do { \
    if (!(cond)) { \
        fprintf(stderr, "  FAIL %s:%d: expected true: %s\n", __FILE__, __LINE__, #cond); \
        g_tests_failed++; \
        return; \
    } \
} while (0)

#define ASSERT_FALSE(cond) do { \
    if ((cond)) { \
        fprintf(stderr, "  FAIL %s:%d: expected false: %s\n", __FILE__, __LINE__, #cond); \
        g_tests_failed++; \
        return; \
    } \
} while (0)

#define ASSERT_NOT_NULL(ptr) do { \
    if ((ptr) == NULL) { \
        fprintf(stderr, "  FAIL %s:%d: expected non-NULL: %s\n", __FILE__, __LINE__, #ptr); \
        g_tests_failed++; \
        return; \
    } \
} while (0)

#define ASSERT_NULL(ptr) do { \
    if ((ptr) != NULL) { \
        fprintf(stderr, "  FAIL %s:%d: expected NULL: %s\n", __FILE__, __LINE__, #ptr); \
        g_tests_failed++; \
        return; \
    } \
} while (0)

#define ASSERT_EQ_INT(want, got) do { \
    long long _w = (long long)(want); \
    long long _g = (long long)(got); \
    if (_w != _g) { \
        fprintf(stderr, "  FAIL %s:%d: expected %lld, got %lld (%s)\n", __FILE__, __LINE__, _w, _g, #got); \
        g_tests_failed++; \
        return; \
    } \
} while (0)

#define ASSERT_EQ_SIZE(want, got) do { \
    size_t _w = (size_t)(want); \
    size_t _g = (size_t)(got); \
    if (_w != _g) { \
        fprintf(stderr, "  FAIL %s:%d: expected %zu, got %zu (%s)\n", __FILE__, __LINE__, _w, _g, #got); \
        g_tests_failed++; \
        return; \
    } \
} while (0)

#define ASSERT_EQ_DBL(want, got, eps) do { \
    double _w = (double)(want); \
    double _g = (double)(got); \
    if (fabs(_w - _g) > (eps)) { \
        fprintf(stderr, "  FAIL %s:%d: expected %.6f, got %.6f (%s)\n", __FILE__, __LINE__, _w, _g, #got); \
        g_tests_failed++; \
        return; \
    } \
} while (0)

#define ASSERT_EQ_STR(want, got) do { \
    const char *_w = (want); \
    const char *_g = (got); \
    if (_w == NULL || _g == NULL || strcmp(_w, _g) != 0) { \
        fprintf(stderr, "  FAIL %s:%d: expected \"%s\", got \"%s\"\n", __FILE__, __LINE__, _w ? _w : "(null)", _g ? _g : "(null)"); \
        g_tests_failed++; \
        return; \
    } \
} while (0)

#define ASSERT_STR_CONTAINS(haystack, needle) do { \
    const char *_h = (haystack); \
    const char *_n = (needle); \
    if (_h == NULL || _n == NULL || strstr(_h, _n) == NULL) { \
        fprintf(stderr, "  FAIL %s:%d: expected \"%s\" to contain \"%s\"\n", __FILE__, __LINE__, _h ? _h : "(null)", _n ? _n : "(null)"); \
        g_tests_failed++; \
        return; \
    } \
} while (0)

#define ASSERT_EQ_ERR(want, got) do { \
    o11y_err_t _w = (want); \
    o11y_err_t _g = (got); \
    if (_w != _g) { \
        fprintf(stderr, "  FAIL %s:%d: expected %s (%d), got %s (%d)\n", __FILE__, __LINE__, o11y_err_name(_w), (int)_w, o11y_err_name(_g), (int)_g); \
        g_tests_failed++; \
        return; \
    } \
} while (0)

#define RUN_TEST(fn) do { \
    int _before = g_tests_failed; \
    g_tests_run++; \
    fn(); \
    if (g_tests_failed == _before) { \
        printf("  PASS %s\n", #fn); \
    } else { \
        printf("  FAIL %s\n", #fn); \
    } \
} while (0)

#define TEST_SUMMARY(suite) do { \
    printf("%s: %d run, %d failed\n", (suite), g_tests_run, g_tests_failed); \
    return g_tests_failed == 0 ? 0 : 1; \
} while (0)

#endif /* O11Y_TEST_FRAMEWORK_H */
