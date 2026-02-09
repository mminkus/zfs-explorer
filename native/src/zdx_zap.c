#include "zdbdecode_internal.h"

/*
 * Stub implementations for M2 functions
 */

zdx_result_t
zdx_zap_info(zdx_pool_t *pool, uint64_t objid)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    objset_t *mos = spa_meta_objset(pool->spa);
    if (!mos)
        return make_error(EINVAL, "failed to access MOS");

    zap_stats_t zs;
    int err = zap_get_stats(mos, objid, &zs);
    if (err != 0)
        return make_error(err, "zap_get_stats failed: %s", strerror(err));

    int is_micro = (zs.zs_ptrtbl_len == 0);
    char *result = json_format(
        "{"
        "\"object\":%llu,"
        "\"kind\":\"%s\","
        "\"block_size\":%llu,"
        "\"num_entries\":%llu,"
        "\"num_blocks\":%llu,"
        "\"num_leafs\":%llu,"
        "\"ptrtbl_len\":%llu,"
        "\"ptrtbl_zt_blk\":%llu,"
        "\"ptrtbl_zt_numblks\":%llu,"
        "\"ptrtbl_zt_shift\":%llu,"
        "\"ptrtbl_blks_copied\":%llu,"
        "\"ptrtbl_nextblk\":%llu,"
        "\"zap_block_type\":%llu,"
        "\"zap_magic\":%llu,"
        "\"zap_salt\":%llu"
        "}",
        (unsigned long long)objid,
        is_micro ? "microzap" : "fatzap",
        (unsigned long long)zs.zs_blocksize,
        (unsigned long long)zs.zs_num_entries,
        (unsigned long long)zs.zs_num_blocks,
        (unsigned long long)zs.zs_num_leafs,
        (unsigned long long)zs.zs_ptrtbl_len,
        (unsigned long long)zs.zs_ptrtbl_zt_blk,
        (unsigned long long)zs.zs_ptrtbl_zt_numblks,
        (unsigned long long)zs.zs_ptrtbl_zt_shift,
        (unsigned long long)zs.zs_ptrtbl_blks_copied,
        (unsigned long long)zs.zs_ptrtbl_nextblk,
        (unsigned long long)zs.zs_block_type,
        (unsigned long long)zs.zs_magic,
        (unsigned long long)zs.zs_salt);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

zdx_result_t
zdx_zap_entries(zdx_pool_t *pool, uint64_t objid,
               uint64_t cursor, uint64_t limit)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    objset_t *mos = spa_meta_objset(pool->spa);
    if (!mos)
        return make_error(EINVAL, "failed to access MOS");

    zap_cursor_t zc;
    zap_cursor_init_serialized(&zc, mos, objid, cursor);

    zap_attribute_t *attrp = zap_attribute_long_alloc();
    if (!attrp) {
        zap_cursor_fini(&zc);
        return make_error(ENOMEM, "failed to allocate zap attribute");
    }

    char *array = json_array_start();
    if (!array) {
        zap_attribute_free(attrp);
        zap_cursor_fini(&zc);
        return make_error(ENOMEM, "failed to allocate JSON array");
    }

    uint64_t count = 0;
    int err = 0;
    int done = 0;
    const size_t max_value_bytes = 1024 * 1024;

    while (count < limit) {
        err = zap_cursor_retrieve(&zc, attrp);
        if (err == ENOENT) {
            done = 1;
            break;
        }
        if (err != 0) {
            free(array);
            zap_attribute_free(attrp);
            zap_cursor_fini(&zc);
            return make_error(err, "zap_cursor_retrieve failed: %s",
                strerror(err));
        }

        boolean_t key64 =
            !!(zap_getflags(zc.zc_zap) & ZAP_FLAG_UINT64_KEY);

        uint64_t key_u64 = 0;
        char *name_json = NULL;
        if (key64) {
            memcpy(&key_u64, attrp->za_name, sizeof (uint64_t));
            char *key_str = json_format("0x%016llx",
                (unsigned long long)key_u64);
            if (!key_str) {
                free(array);
                zap_attribute_free(attrp);
                zap_cursor_fini(&zc);
                return make_error(ENOMEM, "failed to allocate key string");
            }
            name_json = json_string(key_str);
            free(key_str);
        } else {
            name_json = json_string(attrp->za_name);
        }

        if (!name_json) {
            free(array);
            zap_attribute_free(attrp);
            zap_cursor_fini(&zc);
            return make_error(ENOMEM, "failed to allocate name string");
        }

        uint64_t value_u64 = 0;
        int maybe_ref = 0;
        uint64_t target_obj = 0;
        char *value_preview = NULL;
        int truncated = 0;

        if (attrp->za_num_integers > 0) {
            size_t size = (size_t)attrp->za_num_integers *
                (size_t)attrp->za_integer_length;
            if (size > max_value_bytes) {
                truncated = 1;
                value_preview = strdup("(truncated)");
            } else {
                void *prop = calloc(1, size);
                if (!prop) {
                    free(name_json);
                    free(array);
                    zap_attribute_free(attrp);
                    zap_cursor_fini(&zc);
                    return make_error(ENOMEM, "failed to allocate zap value");
                }

                int lookup_err;
                if (key64) {
                    lookup_err = zap_lookup_uint64(mos, objid,
                        (const uint64_t *)attrp->za_name, 1,
                        attrp->za_integer_length,
                        attrp->za_num_integers, prop);
                } else {
                    lookup_err = zap_lookup(mos, objid, attrp->za_name,
                        attrp->za_integer_length,
                        attrp->za_num_integers, prop);
                }

                if (lookup_err != 0) {
                    free(prop);
                    free(name_json);
                    free(array);
                    zap_attribute_free(attrp);
                    zap_cursor_fini(&zc);
                    return make_error(lookup_err, "zap_lookup failed: %s",
                        strerror(lookup_err));
                }

                if (attrp->za_integer_length == 8 &&
                    attrp->za_num_integers == 1) {
                    value_u64 = ((uint64_t *)prop)[0];
                    if (value_u64 != 0) {
                        dmu_object_info_t tmp;
                        if (dmu_object_info(mos, value_u64, &tmp) == 0) {
                            maybe_ref = 1;
                            target_obj = value_u64;
                        }
                    }
                }

                if (attrp->za_integer_length == 1) {
                    uint8_t *u8 = (uint8_t *)prop;
                    int printable = 1;
                    for (uint64_t i = 0; i < attrp->za_num_integers; i++) {
                        if (u8[i] == 0) {
                            if (i + 1 != attrp->za_num_integers) {
                                printable = 0;
                                break;
                            }
                            continue;
                        }
                        if (!isprint(u8[i]) && !isspace(u8[i])) {
                            printable = 0;
                            break;
                        }
                    }

                    if (printable) {
                        size_t slen = attrp->za_num_integers;
                        if (slen > 0 && u8[slen - 1] == 0)
                            slen--;
                        char *tmp = malloc(slen + 1);
                        if (tmp) {
                            memcpy(tmp, u8, slen);
                            tmp[slen] = '\0';
                            value_preview = tmp;
                        }
                    }

                    if (!value_preview) {
                        value_preview = bytes_to_hex(u8,
                            (size_t)attrp->za_num_integers);
                    }
                } else {
                    value_preview = numbers_preview(prop,
                        attrp->za_num_integers, attrp->za_integer_length);
                }

                free(prop);
            }
        } else {
            value_preview = strdup("");
        }

        if (!value_preview)
            value_preview = strdup("");

        char *value_json = json_string(value_preview);
        if (!value_json) {
            free(value_preview);
            free(name_json);
            free(array);
            zap_attribute_free(attrp);
            zap_cursor_fini(&zc);
            return make_error(ENOMEM, "failed to allocate value string");
        }

        char key_buf[32];
        char value_buf[32];
        const char *key_json = "null";
        const char *value_u64_json = "null";
        const char *ref_json = "null";
        const char *target_json = "null";

        if (key64) {
            (void)snprintf(key_buf, sizeof (key_buf), "%llu",
                (unsigned long long)key_u64);
            key_json = key_buf;
        }

        if (attrp->za_integer_length == 8 && attrp->za_num_integers == 1) {
            (void)snprintf(value_buf, sizeof (value_buf), "%llu",
                (unsigned long long)value_u64);
            value_u64_json = value_buf;
            ref_json = value_buf;
        }
        if (maybe_ref) {
            (void)snprintf(value_buf, sizeof (value_buf), "%llu",
                (unsigned long long)target_obj);
            target_json = value_buf;
        }

        char *item = json_format(
            "{"
            "\"name\":%s,"
            "\"key_u64\":%s,"
            "\"integer_length\":%d,"
            "\"num_integers\":%llu,"
            "\"value_preview\":%s,"
            "\"value_u64\":%s,"
            "\"ref_objid\":%s,"
            "\"maybe_object_ref\":%s,"
            "\"target_obj\":%s,"
            "\"truncated\":%s"
            "}",
            name_json,
            key_json,
            attrp->za_integer_length,
            (unsigned long long)attrp->za_num_integers,
            value_json,
            value_u64_json,
            ref_json,
            maybe_ref ? "true" : "false",
            target_json,
            truncated ? "true" : "false");

        free(value_preview);
        free(value_json);
        free(name_json);

        if (!item) {
            free(array);
            zap_attribute_free(attrp);
            zap_cursor_fini(&zc);
            return make_error(ENOMEM, "failed to allocate JSON item");
        }

        char *new_array = json_array_append(array, item);
        free(item);
        if (!new_array) {
            free(array);
            zap_attribute_free(attrp);
            zap_cursor_fini(&zc);
            return make_error(ENOMEM, "failed to append JSON item");
        }

        free(array);
        array = new_array;
        count++;

        zap_cursor_advance(&zc);
    }

    char *entries_json = json_array_end(array, count > 0);
    free(array);
    if (!entries_json) {
        zap_attribute_free(attrp);
        zap_cursor_fini(&zc);
        return make_error(ENOMEM, "failed to finalize JSON array");
    }

    uint64_t next = 0;
    if (!done)
        next = zap_cursor_serialize(&zc);

    char next_buf[32];
    const char *next_json = "null";
    if (!done) {
        (void)snprintf(next_buf, sizeof (next_buf), "%llu",
            (unsigned long long)next);
        next_json = next_buf;
    }

    char *result = json_format(
        "{"
        "\"object\":%llu,"
        "\"cursor\":%llu,"
        "\"next\":%s,"
        "\"count\":%llu,"
        "\"entries\":%s"
        "}",
        (unsigned long long)objid,
        (unsigned long long)cursor,
        next_json,
        (unsigned long long)count,
        entries_json);

    free(entries_json);
    zap_attribute_free(attrp);
    zap_cursor_fini(&zc);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

