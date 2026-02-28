#include "helpers.h"

#include <errno.h>
#include <limits.h>
#include <stddef.h>

uint64_t
zdx_u64_add_sat(uint64_t a, uint64_t b)
{
    if (UINT64_MAX - a < b)
        return UINT64_MAX;
    return a + b;
}

uint64_t
zdx_u64_mul_sat(uint64_t a, uint64_t b)
{
    if (a == 0 || b == 0)
        return 0;
    if (a > UINT64_MAX / b)
        return UINT64_MAX;
    return a * b;
}

uint64_t
zdx_u64_clamp(uint64_t value, uint64_t min_value, uint64_t max_value)
{
    if (min_value > max_value) {
        uint64_t tmp = min_value;
        min_value = max_value;
        max_value = tmp;
    }

    if (value < min_value)
        return min_value;
    if (value > max_value)
        return max_value;
    return value;
}

int
zdx_parse_u64_token_base(const char *s, int base, const char **next,
    uint64_t *value)
{
    const char *p = s;
    uint64_t acc = 0;
    int saw_digit = 0;

    if (s == NULL || value == NULL || (base != 10 && base != 16))
        return EINVAL;

    while (*p != '\0') {
        int digit = -1;

        if (*p >= '0' && *p <= '9') {
            digit = *p - '0';
        } else if (base == 16 && *p >= 'a' && *p <= 'f') {
            digit = 10 + (*p - 'a');
        } else if (base == 16 && *p >= 'A' && *p <= 'F') {
            digit = 10 + (*p - 'A');
        }

        if (digit < 0 || digit >= base)
            break;

        saw_digit = 1;
        if (acc > ((UINT64_MAX - (uint64_t)digit) / (uint64_t)base))
            return ERANGE;
        acc = (acc * (uint64_t)base) + (uint64_t)digit;
        p++;
    }

    if (!saw_digit)
        return EINVAL;
    if (next != NULL)
        *next = p;
    *value = acc;
    return 0;
}

int
zdx_normalize_errno(int err)
{
    if (err == 0)
        return 0;

    if (err > 0)
        return err;

    /*
     * Many lower-level call sites report kernel/libzfs style negative errno
     * values. Normalize to positive errno-style codes for stable envelopes.
     */
    if (err >= -4095)
        return -err;

    return EINVAL;
}
