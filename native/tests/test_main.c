#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../src/helpers.h"
#include "../src/json.h"

static int g_failures = 0;

#define ASSERT_TRUE(expr, msg)                                                     \
    do {                                                                           \
        if (!(expr)) {                                                             \
            fprintf(stderr, "FAIL: %s\n", msg);                                    \
            g_failures++;                                                          \
        }                                                                          \
    } while (0)

static void
assert_string_eq(const char *label, const char *actual, const char *expected)
{
    if (actual == NULL) {
        fprintf(stderr, "FAIL: %s returned NULL\n", label);
        g_failures++;
        return;
    }

    if (strcmp(actual, expected) != 0) {
        fprintf(stderr, "FAIL: %s\n", label);
        fprintf(stderr, "  expected: %s\n", expected);
        fprintf(stderr, "  actual:   %s\n", actual);
        g_failures++;
    }
}

static void
test_json_string_cases(void)
{
    struct json_case {
        const char *name;
        const char *input;
        const char *expected;
    } cases[] = {
        { "plain", "tank", "\"tank\"" },
        { "quotes", "a\"b", "\"a\\\"b\"" },
        { "slash", "a\\b", "\"a\\\\b\"" },
        { "newline", "a\nb", "\"a\\nb\"" },
        { "tab", "a\tb", "\"a\\tb\"" },
        { "control", "x\x01y", "\"x\\u0001y\"" },
    };

    size_t case_count = sizeof(cases) / sizeof(cases[0]);
    for (size_t i = 0; i < case_count; i++) {
        char *actual = json_string(cases[i].input);
        assert_string_eq(cases[i].name, actual, cases[i].expected);
        free(actual);
    }
}

static void
test_json_array_helpers(void)
{
    char *array = json_array_start();
    ASSERT_TRUE(array != NULL, "json_array_start allocates");

    char *with_one = json_array_append(array, "1");
    free(array);
    ASSERT_TRUE(with_one != NULL, "json_array_append first item");

    char *with_two = json_array_append(with_one, "2");
    free(with_one);
    ASSERT_TRUE(with_two != NULL, "json_array_append second item");

    char *ended = json_array_end(with_two, 1);
    free(with_two);
    assert_string_eq("json_array_end trims trailing comma", ended, "[1,2]");
    free(ended);

    array = json_array_start();
    ASSERT_TRUE(array != NULL, "json_array_start for empty array");
    ended = json_array_end(array, 0);
    free(array);
    assert_string_eq("json_array_end empty", ended, "[]");
    free(ended);
}

static void
test_json_object_helpers(void)
{
    char *obj = json_object_start();
    ASSERT_TRUE(obj != NULL, "json_object_start allocates");

    char *step = json_object_add_string(obj, "name", "pool \"tank\"");
    free(obj);
    ASSERT_TRUE(step != NULL, "json_object_add_string");

    obj = json_object_add_int(step, "count", 7);
    free(step);
    ASSERT_TRUE(obj != NULL, "json_object_add_int");

    step = json_object_add_bool(obj, "healthy", 1);
    free(obj);
    ASSERT_TRUE(step != NULL, "json_object_add_bool");

    obj = json_object_add_null(step, "hint");
    free(step);
    ASSERT_TRUE(obj != NULL, "json_object_add_null");

    char *ended = json_object_end(obj, 1);
    free(obj);
    assert_string_eq(
        "json_object_end trims trailing comma",
        ended,
        "{\"name\":\"pool \\\"tank\\\"\",\"count\":7,\"healthy\":true,\"hint\":null}"
    );
    free(ended);

    obj = json_object_start();
    ASSERT_TRUE(obj != NULL, "json_object_start for empty object");
    ended = json_object_end(obj, 0);
    free(obj);
    assert_string_eq("json_object_end empty", ended, "{}");
    free(ended);
}

static void
test_parse_u64_token_base_cases(void)
{
    struct parse_case {
        const char *name;
        const char *input;
        int base;
        int expected_err;
        uint64_t expected_value;
        char expected_next;
    } cases[] = {
        { "decimal-full", "184", 10, 0, 184, '\0' },
        { "decimal-stops-on-alpha", "123abc", 10, 0, 123, 'a' },
        { "hex-with-delimiter", "ff:1", 16, 0, 255, ':' },
        { "hex-max-u64", "FFFFFFFFFFFFFFFF", 16, 0, UINT64_MAX, '\0' },
        { "empty-input", "", 10, EINVAL, 0, '\0' },
        { "invalid-digit", "xyz", 16, EINVAL, 0, '\0' },
        { "overflow-decimal", "18446744073709551616", 10, ERANGE, 0, '\0' },
    };

    size_t case_count = sizeof(cases) / sizeof(cases[0]);
    for (size_t i = 0; i < case_count; i++) {
        const char *next = NULL;
        uint64_t value = 0;
        int err = zdx_parse_u64_token_base(
            cases[i].input, cases[i].base, &next, &value
        );

        if (err != cases[i].expected_err) {
            fprintf(stderr, "FAIL: %s err expected=%d actual=%d\n",
                cases[i].name, cases[i].expected_err, err);
            g_failures++;
            continue;
        }

        if (err != 0)
            continue;

        if (value != cases[i].expected_value) {
            fprintf(stderr, "FAIL: %s value expected=%llu actual=%llu\n",
                cases[i].name,
                (unsigned long long)cases[i].expected_value,
                (unsigned long long)value);
            g_failures++;
        }

        if (next == NULL) {
            fprintf(stderr, "FAIL: %s next returned NULL\n", cases[i].name);
            g_failures++;
            continue;
        }

        if (*next != cases[i].expected_next) {
            fprintf(stderr, "FAIL: %s next expected='%c' actual='%c'\n",
                cases[i].name,
                cases[i].expected_next ? cases[i].expected_next : '0',
                *next ? *next : '0');
            g_failures++;
        }
    }

    ASSERT_TRUE(
        zdx_parse_u64_token_base(NULL, 10, NULL, NULL) == EINVAL,
        "parse helper rejects null input"
    );
    ASSERT_TRUE(
        zdx_parse_u64_token_base("12", 8, NULL, &(uint64_t){0}) == EINVAL,
        "parse helper rejects unsupported base"
    );
}

static void
test_u64_math_and_clamp_helpers(void)
{
    ASSERT_TRUE(zdx_u64_add_sat(10, 20) == 30, "add_sat basic");
    ASSERT_TRUE(
        zdx_u64_add_sat(UINT64_MAX - 5, 10) == UINT64_MAX,
        "add_sat overflow saturates"
    );

    ASSERT_TRUE(zdx_u64_mul_sat(7, 9) == 63, "mul_sat basic");
    ASSERT_TRUE(
        zdx_u64_mul_sat(UINT64_MAX, 2) == UINT64_MAX,
        "mul_sat overflow saturates"
    );
    ASSERT_TRUE(zdx_u64_mul_sat(0, 12345) == 0, "mul_sat zero short-circuit");

    ASSERT_TRUE(zdx_u64_clamp(5, 1, 10) == 5, "clamp keeps in-range value");
    ASSERT_TRUE(zdx_u64_clamp(0, 1, 10) == 1, "clamp raises low bound");
    ASSERT_TRUE(zdx_u64_clamp(50, 1, 10) == 10, "clamp lowers high bound");
    ASSERT_TRUE(
        zdx_u64_clamp(7, 10, 3) == 7,
        "clamp tolerates reversed bounds"
    );
}

static void
test_errno_normalization_helper(void)
{
    struct errno_case {
        int input;
        int expected;
        const char *name;
    } cases[] = {
        { 0, 0, "zero" },
        { EINVAL, EINVAL, "positive errno" },
        { -EINVAL, EINVAL, "negative errno" },
        { -5, 5, "small negative code" },
        { -5000, EINVAL, "out-of-range negative code" },
        { INT_MIN, EINVAL, "int min defensive fallback" },
    };

    size_t case_count = sizeof(cases) / sizeof(cases[0]);
    for (size_t i = 0; i < case_count; i++) {
        int actual = zdx_normalize_errno(cases[i].input);
        if (actual != cases[i].expected) {
            fprintf(stderr, "FAIL: %s expected=%d actual=%d\n",
                cases[i].name, cases[i].expected, actual);
            g_failures++;
        }
    }
}

int
main(void)
{
    test_json_string_cases();
    test_json_array_helpers();
    test_json_object_helpers();
    test_parse_u64_token_base_cases();
    test_u64_math_and_clamp_helpers();
    test_errno_normalization_helper();

    if (g_failures != 0) {
        fprintf(stderr, "native unit tests failed: %d\n", g_failures);
        return 1;
    }

    printf("native unit tests passed\n");
    return 0;
}
