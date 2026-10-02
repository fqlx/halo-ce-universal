#!/usr/bin/env python3
"""Exercise the production WebGL visibility queue with a fake GL transfer boundary.

Run: python3 tools/test_web_visibility.py

The actual C queue and D3D Begin/End/Get functions are compiled with ASan/UBSan.
The fake GL records pixel snapshots, buffers and readback calls; it does not
simulate rasterization, GPU scheduling, WebGL validation or browser drivers.
Real browser coverage is still required for those behaviors.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
SOURCE = (ROOT / "port/linux/src/d3d8_gl.c").read_text()


def remove_function(source, name):
    match = re.search(r"static [\w *]+\b" + name + r"\([^;]*?\)\s*\{", source)
    assert match, name
    end, depth = match.end(), 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[:match.start()] + source[end:]


DEFINITIONS = SOURCE[SOURCE.index("#define VISIBILITY_TEST_SLOTS"):
                     SOURCE.index("struct gl_device\n")]
FIELDS = SOURCE[SOURCE.index("\tGLuint queries[VISIBILITY_TEST_SLOTS];"):
                SOURCE.index("\n\tunsigned long frame;")]
FUNCTIONS = SOURCE[SOURCE.index("/* ---------- visibility (occlusion) tests */"):
                   SOURCE.index("/* ---------- render and texture stage state */")]
# The rasterizer's mask draw is outside this test boundary. Tests supply the
# already-rendered mask at End, as the real prepare_draw path does.
for excluded in ("visibility_mask_bind", "visibility_test_record"):
    if re.search(r"\b" + excluded + r"\(", FUNCTIONS):
        FUNCTIONS = remove_function(FUNCTIONS, excluded)

BOUNDARY = r'''
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
typedef int BOOL, HRESULT, GLint, GLsizei;
typedef unsigned int GLuint, GLenum, UINT;
typedef uint32_t DWORD;
typedef uint64_t ULONGLONG;
typedef intptr_t GLintptr, GLsizeiptr;
#define HALO_WEB 1
#define HALO_ANDROID 1
#define WINAPI
#define TRUE 1
#define FALSE 0
#define S_OK 0
#define D3DERR_TESTINCOMPLETE -1
#define GL_PIXEL_PACK_BUFFER 0x88eb
#define GL_PIXEL_PACK_BUFFER_BINDING 0x88ed
#define GL_BUFFER_SIZE 0x8764
#define GL_STREAM_READ 0x88e1
#define GL_DYNAMIC_READ 0x88e9
#define GL_RGBA 0x1908
#define GL_UNSIGNED_BYTE 0x1401
#define GL_NO_ERROR 0
#define GL_ATOMIC_COUNTER_BUFFER 0x92c0
#define GL_QUERY_RESULT 0x8866
#define GL_QUERY_RESULT_AVAILABLE 0x8867
#define GL_ANY_SAMPLES_PASSED 0x8c2f
#define GL_PACK_ALIGNMENT 0x0d05
#define GL_PACK_ROW_LENGTH 0x0d02
#define GL_PACK_SKIP_PIXELS 0x0d04
#define GL_PACK_SKIP_ROWS 0x0d03
static struct { int atomic_counters; } xgpu_capabilities;
static struct { unsigned long visibility_batches, visibility_immediate_reads,
    visibility_bytes, visibility_tests, visibility_spills, visibility_captures; } stats;
static float target_scale[2] = {1, 1};
static GLuint pack_binding;
static unsigned int next_buffer = 1;
static struct { unsigned char *bytes; size_t size; } buffers[32];
static unsigned long source_samples;
static unsigned int source_width, source_height;
static unsigned int pixel_reads, cpu_pixel_reads, buffer_reads;
static GLint pack_alignment = 4, pack_row_length, pack_skip_pixels, pack_skip_rows;

static GLuint framebuffer_get(GLuint color, GLuint depth) {
    assert(color && depth); return color + depth;
}
static void state_framebuffer(GLuint framebuffer) { assert(framebuffer); }
static void glGenBuffers(GLsizei count, GLuint *ids) {
    for (int i = 0; i < count; ++i) { assert(next_buffer < 32); ids[i] = next_buffer++; }
}
static void glDeleteBuffers(GLsizei count, const GLuint *ids) {
    for (int i = 0; i < count; ++i) {
        free(buffers[ids[i]].bytes); buffers[ids[i]].bytes = NULL;
        buffers[ids[i]].size = 0;
        if (pack_binding == ids[i]) pack_binding = 0;
    }
}
static GLenum pending_gl_error;
static int fail_gpu_allocation;
static GLenum glGetError(void) { GLenum error = pending_gl_error; pending_gl_error = 0; return error; }
#define platform_log(...) ((void)0)
static void glBindBuffer(GLenum target, GLuint buffer) {
    assert(target == GL_PIXEL_PACK_BUFFER); assert(buffer < 32); pack_binding = buffer;
}
static void glBufferData(GLenum target, GLsizeiptr size, const void *data, GLenum usage) {
    assert(target == GL_PIXEL_PACK_BUFFER && pack_binding && size >= 0);
    (void)usage; free(buffers[pack_binding].bytes);
    if (fail_gpu_allocation) {
        buffers[pack_binding].bytes = NULL; buffers[pack_binding].size = 0;
        pending_gl_error = 0x0505; /* GL_OUT_OF_MEMORY */
        return;
    }
    buffers[pack_binding].bytes = malloc((size_t)size);
    assert(buffers[pack_binding].bytes);
    buffers[pack_binding].size = (size_t)size;
    if (data) memcpy(buffers[pack_binding].bytes, data, (size_t)size);
}
static void glGetBufferParameteriv(GLenum target, GLenum name, GLint *value) {
    assert(target == GL_PIXEL_PACK_BUFFER && pack_binding && name == GL_BUFFER_SIZE);
    *value = (GLint)buffers[pack_binding].size;
}
static void glGetIntegerv(GLenum name, GLint *value) {
    switch (name) {
    case GL_PIXEL_PACK_BUFFER_BINDING: *value = (GLint)pack_binding; break;
    case GL_PACK_ALIGNMENT: *value = pack_alignment; break;
    case GL_PACK_ROW_LENGTH: *value = pack_row_length; break;
    case GL_PACK_SKIP_PIXELS: *value = pack_skip_pixels; break;
    case GL_PACK_SKIP_ROWS: *value = pack_skip_rows; break;
    default: assert(!"unexpected GL state query");
    }
}
static void glPixelStorei(GLenum name, GLint value) {
    switch (name) {
    case GL_PACK_ALIGNMENT: pack_alignment = value; break;
    case GL_PACK_ROW_LENGTH: pack_row_length = value; break;
    case GL_PACK_SKIP_PIXELS: pack_skip_pixels = value; break;
    case GL_PACK_SKIP_ROWS: pack_skip_rows = value; break;
    default: assert(!"unexpected pixel-store state");
    }
}
static void glReadPixels(GLint x, GLint y, GLsizei width, GLsizei height,
    GLenum format, GLenum type, void *destination) {
    assert(width >= 0 && height >= 0 && format == GL_RGBA && type == GL_UNSIGNED_BYTE);
    assert(x >= 0 && y >= 0 && (unsigned int)(x + width) <= source_width &&
        (unsigned int)(y + height) <= source_height);
    assert(pack_alignment == 1 || pack_alignment == 4);
    assert(!pack_row_length && !pack_skip_pixels && !pack_skip_rows);
    size_t pixels = (size_t)width * (size_t)height, bytes = pixels * 4;
    unsigned char *out = destination;
    pixel_reads++;
    if (pack_binding) {
        size_t offset = (uintptr_t)destination;
        assert(offset <= buffers[pack_binding].size && bytes <= buffers[pack_binding].size - offset);
        out = buffers[pack_binding].bytes + offset;
    } else cpu_pixel_reads++;
    assert(out || !bytes);
    memset(out, 0, bytes);
    for (int row = 0; row < height; ++row)
    for (int column = 0; column < width; ++column)
        if ((unsigned long)(y + row) * source_width + (unsigned int)(x + column) < source_samples)
            out[((size_t)row * (size_t)width + (size_t)column) * 4] = 255;
}
static void glGetBufferSubData(GLenum target, GLintptr offset, GLsizeiptr size, void *out) {
    assert(target == GL_PIXEL_PACK_BUFFER && pack_binding && offset >= 0 && size >= 0);
    assert((size_t)offset <= buffers[pack_binding].size &&
        (size_t)size <= buffers[pack_binding].size - (size_t)offset);
    memcpy(out, buffers[pack_binding].bytes + offset, (size_t)size); buffer_reads++;
}
static void glBeginQuery(GLenum target, GLuint query) { (void)target; (void)query; assert(0); }
static void glEndQuery(GLenum target) { (void)target; assert(0); }
static void glGetQueryObjectuiv(GLuint query, GLenum name, GLuint *value) {
    (void)query; (void)name; (void)value; assert(0);
}
static void host_gl_buffer_write(unsigned int target, unsigned int offset, unsigned int size, const void *data) {
    (void)target; (void)offset; (void)size; (void)data; assert(0);
}
static unsigned int host_gl_read_buffer_word(unsigned int buffer, unsigned int offset) {
    (void)buffer; (void)offset; assert(0); return 0;
}
static void host_gl_read_buffer(unsigned int target, unsigned int offset, unsigned int size, void *data) {
    glGetBufferSubData(target, (GLintptr)offset, (GLsizeiptr)size, data);
}
static int readback_mode = -1;
static int host_gl_visibility_readback_mode(void) { return readback_mode; }
static int fail_cpu_allocation;
static void *visibility_malloc(size_t size) { return fail_cpu_allocation ? NULL : malloc(size); }
'''


def main():
    with tempfile.TemporaryDirectory(prefix="halo-web-visibility-") as directory:
        path = Path(directory)
        # The production declarations are kept intact, including capacities and
        # queue metadata; only unrelated rendering/device fields are omitted.
        def run(name, functions):
            source, binary = path / f"{name}.c", path / name
            source.write_text(BOUNDARY + DEFINITIONS + "\nstruct {\nBOOL gl_ready;\n" +
                              FIELDS + "\n} device;\n#define malloc visibility_malloc\n" +
                              functions + "\n#undef malloc\n" + CASES)
            subprocess.run([os.environ.get("CC", "clang"), "-std=c11", "-g", "-O1",
                            "-Wall", "-Wextra", "-Werror", "-Wno-unused-function",
                            "-fsanitize=address,undefined", str(source), "-lm", "-o", str(binary)], check=True)
            return subprocess.run([str(binary)], text=True, capture_output=True)

        result = run("visibility", FUNCTIONS)
        assert result.returncode == 0, result.stdout + result.stderr
        print(result.stdout, end="")
        # Negative controls ensure the harness rejects actual past failure
        # modes and a missing generation guard instead of mirroring the code.
        controls = {
            "slot-alias": ("index %= VISIBILITY_TEST_SLOTS;",
                           "index %= VISIBILITY_TEST_SLOTS; if (!index) index = 1;"),
            "stale-generation": ("capture->generation == device.visibility_generation[capture->slot]", "TRUE"),
            "unrelated-gl-error": ("buffer_size != VISIBILITY_BATCH_BYTES", "glGetError() != GL_NO_ERROR"),
        }
        for name, (old, replacement) in controls.items():
            assert old in FUNCTIONS, name
            result = run(name, FUNCTIONS.replace(old, replacement))
            assert result.returncode != 0 and "Assertion" in result.stderr, result.stdout + result.stderr
            print(f"PASS negative control rejects {name}")


CASES = r'''
static void submit(DWORD slot, int width, int height, unsigned long visible, int depth) {
    D3DDevice_BeginVisibilityTest();
    device.visibility_mask = 5;
    device.visibility_mask_depth = depth ? 6 : 0;
    device.visibility_rect[0] = 0;
    device.visibility_rect[1] = 0;
    device.visibility_rect[2] = width;
    device.visibility_rect[3] = height;
    source_samples = visible;
    source_width = (unsigned int)width;
    source_height = (unsigned int)height;
    assert(D3DDevice_EndVisibilityTest(slot) == S_OK);
    assert(pack_binding == 0); /* A CPU screenshot must never inherit our PBO. */
}
static UINT result(DWORD slot) {
    UINT count = 0xdeadbeef;
    ULONGLONG timestamp = 999;
    assert(D3DDevice_GetVisibilityTestResult(slot, &count, &timestamp) == S_OK);
    assert(timestamp == 0 && pack_binding == 0); return count;
}
static void clear_device(void) {
    for (unsigned int i = 1; i < next_buffer; ++i) free(buffers[i].bytes);
    memset(buffers, 0, sizeof(buffers)); next_buffer = 1;
    fail_gpu_allocation = 0; pending_gl_error = 0;
    free(device.visibility_pixels); memset(&device, 0, sizeof(device));
    device.gl_ready = TRUE;
}
int main(void) {
    device.gl_ready = TRUE;
    assert(result(4000) == 0);
    submit(0, 4, 4, 3, 1);
    submit(1, 4, 4, 11, 1);
    assert(cpu_pixel_reads == 0 && buffer_reads == 0);
    source_samples = 0; /* Scene/mask changes after submission cannot change results. */
    assert(result(0) == 3 && result(1) == 11);
    assert(buffer_reads == 1);
    puts("PASS distinct slots 0/1, batched first Get and original mask snapshots");

    unsigned int before = buffer_reads;
    for (unsigned int i = 0; i < 1024; ++i) submit(i, 4, 4, i % 17, 1);
    for (unsigned int i = 0; i < 1024; ++i) assert(result(i) == i % 17);
    assert(buffer_reads > before && cpu_pixel_reads == 0);
    puts("PASS 1024 query slots, including records beyond the old 256 limit");

    before = buffer_reads;
    for (unsigned int i = 0; i < 1025; ++i) submit(i, 4, 4, i % 17, 1);
    assert(buffer_reads == before + 1);
    for (unsigned int i = 0; i < 1025; ++i) assert(result(i) == i % 17);
    assert(buffer_reads == before + 2);
    puts("PASS metadata-capacity overflow drains preserve all 1025 records");

    submit(0xfff, 4, 4, 7, 1);
    assert(result(0xfff) == 7);
    submit(0xfff, 4, 4, 2, 1);
    assert(result(0xfff) == 2);
    submit(3, 4, 4, 1, 1); submit(3, 4, 4, 9, 1);
    assert(result(3) == 9);
    puts("PASS immediate debug-counter Get and last submission wins on slot reuse");

    submit(3, 4, 4, 1, 1); submit(4, 4, 4, 2, 1);
    submit(3, 0, 4, 0, 1);
    assert(result(3) == 0 && result(4) == 2 && result(3) == 0);
    submit(3, 4, 4, 1, 1); submit(4, 4, 4, 2, 1);
    submit(3, 4, 4, 0, 0);
    assert(result(3) == VISIBILITY_ALL_SAMPLES && result(4) == 2 &&
        result(3) == VISIBILITY_ALL_SAMPLES);
    puts("PASS older queued captures cannot overwrite later immediate slot results");

    before = pixel_reads;
    submit(7, 0, 4, 0, 1); assert(result(7) == 0);
    submit(8, 4, 4, 0, 0); assert(result(8) == VISIBILITY_ALL_SAMPLES);
    assert(pixel_reads == before);
    target_scale[0] = 2; target_scale[1] = 3;
    submit(9, 4, 4, 12, 1);
    target_scale[0] = target_scale[1] = 1;
    assert(result(9) == 2);
    puts("PASS empty/missing-depth results and submission-time render scale");

    /* A bounded staging buffer must drain rather than lose or overwrite old
       pixels when large masks exceed its byte capacity. */
    before = buffer_reads;
    for (unsigned int i = 0; i < 12; ++i) submit(i, 1024, 1024, 100 + i, 1);
    assert(buffer_reads > before);
    for (unsigned int i = 0; i < 12; ++i) assert(result(i) == 100 + i);
    assert(cpu_pixel_reads == 0);
    puts("PASS byte-capacity overflow drains preserve every result");

    before = cpu_pixel_reads;
    submit(10, 1024, 1025, 12345, 1);
    assert(result(10) == 12345 && cpu_pixel_reads == before + 2);
    puts("PASS oversized masks use exact bounded tiles");

    clear_device(); readback_mode = 0;
    submit(2, 4, 4, 6, 1);
    readback_mode = 1; submit(3, 4, 4, 8, 1);
    assert(result(2) == 6 && result(3) == 8);
    readback_mode = 0; submit(4, 4, 4, 10, 1);
    assert(result(4) == 10);
    clear_device(); readback_mode = 1; submit(2, 4, 4, 6, 1);
    assert(!device.visibility_buffer);
    readback_mode = 0; submit(3, 4, 4, 8, 1);
    assert(device.visibility_buffer && result(2) == 6 && result(3) == 8);
    readback_mode = -1;
    puts("PASS live mode toggles drain queued work and initialize PBO after immediate startup");

    clear_device(); device.visibility_immediate = TRUE;
    before = cpu_pixel_reads;
    submit(0, 4, 4, 3, 1); submit(1, 4, 4, 11, 1);
    assert(result(0) == 3 && result(1) == 11 && cpu_pixel_reads == before + 2);
    puts("PASS selectable immediate baseline preserves independent query results");

    clear_device(); pending_gl_error = 0x0502; /* Unrelated earlier GL_INVALID_OPERATION */
    before = cpu_pixel_reads;
    submit(15, 4, 4, 13, 1);
    assert(device.visibility_buffer && !device.visibility_buffer_failed);
    assert(result(15) == 13 && cpu_pixel_reads == before);
    assert(pending_gl_error == 0x0502); /* Allocation must not consume other render errors. */
    puts("PASS stale unrelated GL errors cannot disable successfully allocated PBO");

    clear_device(); fail_gpu_allocation = 1;
    before = cpu_pixel_reads;
    submit(15, 4, 4, 13, 1);
    assert(result(15) == 13 && cpu_pixel_reads == before + 1);
    assert(!device.visibility_buffer && device.visibility_buffer_failed);
    puts("PASS GL allocation failure falls back to exact immediate readback");

    clear_device(); fail_cpu_allocation = 1;
    before = cpu_pixel_reads;
    submit(15, 2048, 3, 2345, 1);
    assert(result(15) == 2345 && cpu_pixel_reads == before + 6);
    assert(!device.visibility_pixels);
    puts("PASS allocation failure uses bounded stack fallback with exact coverage");
    clear_device();
    puts("All visibility queue contracts passed (ASan/UBSan; fake GL transfer boundary).");
    return 0;
}
'''

if __name__ == "__main__":
    main()
