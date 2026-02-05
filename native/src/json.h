#ifndef JSON_H
#define JSON_H

/* Simple JSON builder helpers */

char *json_string(const char *str);
char *json_format(const char *fmt, ...);

char *json_array_start(void);
char *json_array_end(const char *array, int has_items);
char *json_array_append(const char *array, const char *item);

char *json_object_start(void);
char *json_object_end(const char *obj, int has_fields);
char *json_object_add_string(const char *obj, const char *key, const char *value);
char *json_object_add_int(const char *obj, const char *key, long long value);
char *json_object_add_bool(const char *obj, const char *key, int value);
char *json_object_add_null(const char *obj, const char *key);

#endif /* JSON_H */
