CC ?= cc
CFLAGS ?= -std=c11 -O2 -g -fPIC
AR = ar

# ZFS prefix - can be overridden
ZFS_PREFIX ?= ../_deps/openzfs

# ZFS source - for headers
ZFS_SRC ?= ../zfs

# Select SPL OS include subtree (Linux default, FreeBSD override/auto-detect)
UNAME_S := $(shell uname -s 2>/dev/null || echo Linux)
ifeq ($(UNAME_S),FreeBSD)
ZFS_OS ?= freebsd
else
ZFS_OS ?= linux
endif

# Get git SHA from ZFS repo
ZDX_GIT_SHA := $(shell git -C $(ZFS_SRC) rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Include paths - use source tree for headers, prefix for libs
CPPFLAGS += -I$(ZFS_SRC)/include
CPPFLAGS += -I$(ZFS_SRC)/lib/libspl/include
CPPFLAGS += -I$(ZFS_SRC)/lib/libspl/include/os/$(ZFS_OS)
CPPFLAGS += -I$(ZFS_SRC)/lib/libzpool/include
CPPFLAGS += -Iinclude
CPPFLAGS += -D_GNU_SOURCE
CPPFLAGS += -DZDX_GIT_SHA=\"$(ZDX_GIT_SHA)\"

# Warning flags
WARNFLAGS = -Wall -Wextra -Wshadow -Wformat=2 -Wstrict-prototypes -Wno-cast-qual

# Library linking
LDFLAGS ?=
# Add RPATH so libzdbdecode.so can find OpenZFS libraries
# $ORIGIN is the directory containing libzdbdecode.so (native/)
LDFLAGS += -Wl,-rpath,'$$ORIGIN/../_deps/openzfs/lib'
LDLIBS = -L$(ZFS_PREFIX)/lib -lzfs -lzpool -lnvpair

# Targets
TARGET = libzdbdecode.so
STATIC_TARGET = libzdbdecode.a

SRCS = src/zdx_core.c \
       src/zdx_pool.c \
       src/zdx_mos.c \
       src/zdx_dsl.c \
       src/zdx_objset.c \
       src/zdx_catalog.c \
       src/zdx_zap.c \
       src/zdx_spacemap.c \
       src/zdx_block.c \
       src/json.c
OBJS = $(SRCS:.c=.o)

.PHONY: all clean

all: $(TARGET) $(STATIC_TARGET)

$(TARGET): $(OBJS)
	$(CC) -shared $(LDFLAGS) -o $@ $(OBJS) $(LDLIBS)

$(STATIC_TARGET): $(OBJS)
	$(AR) rcs $@ $(OBJS)

src/%.o: src/%.c include/zdbdecode.h src/json.h src/zdbdecode_internal.h
	$(CC) $(CPPFLAGS) $(CFLAGS) $(WARNFLAGS) -o $@ -c $<

clean:
	rm -f $(TARGET) $(STATIC_TARGET) $(OBJS)

.SUFFIXES:
