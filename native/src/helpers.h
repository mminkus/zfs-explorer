#ifndef ZDX_HELPERS_H
#define ZDX_HELPERS_H

#include <stdint.h>

uint64_t zdx_u64_add_sat(uint64_t a, uint64_t b);
uint64_t zdx_u64_mul_sat(uint64_t a, uint64_t b);
uint64_t zdx_u64_clamp(uint64_t value, uint64_t min_value, uint64_t max_value);
int zdx_parse_u64_token_base(const char *s, int base, const char **next,
    uint64_t *value);
int zdx_normalize_errno(int err);

#endif /* ZDX_HELPERS_H */
