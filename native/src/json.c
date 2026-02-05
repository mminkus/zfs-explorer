#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>

/* Simple JSON builder - just enough for our needs */

char *
json_string(const char *str)
{
	size_t len = strlen(str);
	size_t escaped_len = len * 2 + 3; /* worst case: all chars escaped + quotes + NUL */
	char *result = malloc(escaped_len);
	if (!result)
		return NULL;

	char *p = result;
	*p++ = '"';

	for (size_t i = 0; i < len; i++) {
		char c = str[i];
		switch (c) {
		case '"':
		case '\\':
			*p++ = '\\';
			*p++ = c;
			break;
		case '\n':
			*p++ = '\\';
			*p++ = 'n';
			break;
		case '\t':
			*p++ = '\\';
			*p++ = 't';
			break;
		case '\r':
			*p++ = '\\';
			*p++ = 'r';
			break;
		default:
			if (c < 32) {
				/* Control character - encode as \uXXXX */
				p += sprintf(p, "\\u%04x", (unsigned char)c);
			} else {
				*p++ = c;
			}
			break;
		}
	}

	*p++ = '"';
	*p = '\0';

	return result;
}

char *
json_format(const char *fmt, ...)
{
	va_list args;
	va_start(args, fmt);

	/* Get required size */
	va_list args_copy;
	va_copy(args_copy, args);
	int size = vsnprintf(NULL, 0, fmt, args_copy);
	va_end(args_copy);

	if (size < 0) {
		va_end(args);
		return NULL;
	}

	char *result = malloc(size + 1);
	if (!result) {
		va_end(args);
		return NULL;
	}

	vsnprintf(result, size + 1, fmt, args);
	va_end(args);

	return result;
}

char *
json_array_start(void)
{
	return strdup("[");
}

char *
json_array_end(const char *array, int has_items)
{
	char *result;
	if (has_items) {
		/* Remove trailing comma */
		size_t len = strlen(array);
		if (len > 0 && array[len-1] == ',') {
			result = malloc(len + 1);
			if (!result)
				return NULL;
			memcpy(result, array, len - 1);
			result[len - 1] = ']';
			result[len] = '\0';
		} else {
			result = json_format("%s]", array);
		}
	} else {
		result = json_format("%s]", array);
	}
	return result;
}

char *
json_array_append(const char *array, const char *item)
{
	return json_format("%s%s,", array, item);
}

char *
json_object_start(void)
{
	return strdup("{");
}

char *
json_object_end(const char *obj, int has_fields)
{
	char *result;
	if (has_fields) {
		/* Remove trailing comma */
		size_t len = strlen(obj);
		if (len > 0 && obj[len-1] == ',') {
			result = malloc(len + 1);
			if (!result)
				return NULL;
			memcpy(result, obj, len - 1);
			result[len - 1] = '}';
			result[len] = '\0';
		} else {
			result = json_format("%s}", obj);
		}
	} else {
		result = json_format("%s}", obj);
	}
	return result;
}

char *
json_object_add_string(const char *obj, const char *key, const char *value)
{
	char *escaped_value = json_string(value);
	if (!escaped_value)
		return NULL;

	char *result = json_format("%s\"%s\":%s,", obj, key, escaped_value);
	free(escaped_value);
	return result;
}

char *
json_object_add_int(const char *obj, const char *key, long long value)
{
	return json_format("%s\"%s\":%lld,", obj, key, value);
}

char *
json_object_add_bool(const char *obj, const char *key, int value)
{
	return json_format("%s\"%s\":%s,", obj, key, value ? "true" : "false");
}

char *
json_object_add_null(const char *obj, const char *key)
{
	return json_format("%s\"%s\":null,", obj, key);
}
