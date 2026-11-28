package ing.o11y.libo11y.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.net.URISyntaxException;
import java.net.URL;
import java.nio.file.Path;
import java.util.Objects;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Container ID detection on cgroup v1 (from /proc/self/cgroup) and cgroup v2 (from
 * /proc/self/mountinfo), with the fixtures under {@code src/test/resources/.../container}.
 */
class ContainerIdTest {
    private static final String DOCKER_V1 = "4f3c2b1a09e8d7c6b5a49382716051f4e3d2c1b0a9f8e7d6c5b4a39281706f5e";
    private static final String DOCKER_V2 = "9e8d7c6b5a4938271605f4e3d2c1b0a9f8e7d6c5b4a392817061f5e4d3c2b1a0";
    private static final String CONTAINERD = "c0ffee00ba5eba11deadbeef0123456789abcdef0123456789abcdef01234567";
    private static final String CRIO = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

    @TempDir
    Path tmp;

    private static Path fixture(String name) {
        URL url = Objects.requireNonNull(ContainerIdTest.class.getResource("container/" + name), name);
        try {
            return Path.of(url.toURI());
        } catch (URISyntaxException ex) {
            throw new IllegalStateException(ex);
        }
    }

    private Path missing() {
        return tmp.resolve("absent");
    }

    @Test
    void cgroupV1ReadsTheIdFromProcSelfCgroup() {
        assertEquals(DOCKER_V1, ResourceComposer.detectContainerId(fixture("cgroup-v1"), missing()));
    }

    @Test
    void cgroupV1TakesPrecedenceOverMountinfo() {
        assertEquals(DOCKER_V1, ResourceComposer.detectContainerId(fixture("cgroup-v1"), fixture("mountinfo-docker")));
    }

    @Test
    void cgroupV2DockerReadsTheContainersMountNotTheOverlayLayer() {
        assertEquals(DOCKER_V2, ResourceComposer.detectContainerId(fixture("cgroup-v2"), fixture("mountinfo-docker")));
    }

    @Test
    void cgroupV2ContainerdReadsTheCriContainerdId() {
        assertEquals(CONTAINERD,
                ResourceComposer.detectContainerId(fixture("cgroup-v2"), fixture("mountinfo-containerd")));
    }

    @Test
    void cgroupV2CrioReadsTheCrioScope() {
        assertEquals(CRIO, ResourceComposer.detectContainerId(fixture("cgroup-v2"), fixture("mountinfo-crio")));
    }

    @Test
    void aHostWithNeitherHasNoContainerId() {
        assertNull(ResourceComposer.detectContainerId(fixture("cgroup-v2-host"), fixture("mountinfo-host")));
        assertNull(ResourceComposer.detectContainerId(missing(), missing()));
    }
}
