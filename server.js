const express = require("express");
const Docker = require("dockerode");
const path = require("path");
const os = require("os");

const app = express();
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

function getHostIP() {
  if (process.env.HOST_IP) return process.env.HOST_IP;
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms)
    ),
  ]);
}

function parseImage(image) {
  let registry = "registry-1.docker.io";
  let repo = image;
  let tag = "latest";
  const lastColon = image.lastIndexOf(":");
  const lastSlash = image.lastIndexOf("/");
  if (lastColon > lastSlash && lastColon > 0) {
    repo = image.slice(0, lastColon);
    tag = image.slice(lastColon + 1);
  }
  const firstSlash = repo.indexOf("/");
  if (
    firstSlash > 0 &&
    (repo.slice(0, firstSlash).includes(".") ||
      repo.slice(0, firstSlash).includes(":"))
  ) {
    registry = repo.slice(0, firstSlash);
    repo = repo.slice(firstSlash + 1);
  } else if (!repo.includes("/")) {
    repo = "library/" + repo;
  }
  return { registry, repo, tag };
}

async function getRemoteDigest(imageName) {
  try {
    const { registry, repo, tag } = parseImage(imageName);
    let authHeader = "";
    if (registry === "registry-1.docker.io") {
      const tokenRes = await fetch(
        `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
        { signal: AbortSignal.timeout(8000) }
      );
      const { token } = await tokenRes.json();
      authHeader = `Bearer ${token}`;
    } else if (registry === "ghcr.io") {
      try {
        const tokenRes = await fetch(
          `https://ghcr.io/token?scope=repository:${repo}:pull`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (tokenRes.ok) {
          const { token } = await tokenRes.json();
          authHeader = `Bearer ${token}`;
        }
      } catch (_) {}
    }
    const headers = {
      Accept: [
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
      ].join(", "),
    };
    if (authHeader) headers.Authorization = authHeader;
    const res = await fetch(
      `https://${registry}/v2/${repo}/manifests/${tag}`,
      { headers, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    return res.headers.get("docker-content-digest");
  } catch (_) {
    return null;
  }
}

// Fast endpoint — only listContainers (no inspect/stats per container)
app.get("/api/containers", async (req, res) => {
  try {
    const containers = await withTimeout(
      docker.listContainers({ all: true }),
      10000
    );
    const hostIP = getHostIP();

    const enriched = containers.map((c) => {
      const ports = (c.Ports || [])
        .filter((p) => p && p.PublicPort)
        .map((p) => ({
          public: p.PublicPort,
          private: p.PrivatePort,
          type: p.Type,
        }));

      const label = c.Labels || {};
      const webUrl =
        label["altitude.url"] ||
        label["homepage.href"] ||
        (ports.length > 0 ? `http://${hostIP}:${ports[0].public}` : null);

      const names = c.Names || [];
      return {
        id: c.Id.slice(0, 12),
        fullId: c.Id,
        name:
          names.length > 0
            ? names[0].replace(/^\//, "")
            : c.Id.slice(0, 12),
        image: c.Image,
        state: c.State,
        status: c.Status,
        ports,
        webUrl,
        created: c.Created,
        labels: label,
        composeProject: label["com.docker.compose.project"] || null,
        composeService: label["com.docker.compose.service"] || null,
        // Filled in by /api/containers/:id/details
        stats: null,
        env: [],
        volumes: [],
        health: null,
        networks: [],
      };
    });

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-container details (inspect + stats) — called individually after cards render
app.get("/api/containers/:id/details", async (req, res) => {
  const id = req.params.id;
  let stats = null;
  let env = [];
  let volumes = [];
  let health = null;
  let networks = [];

  try {
    const info = await withTimeout(
      docker.getContainer(id).inspect(),
      5000
    );
    env = info.Config.Env || [];
    volumes = (info.Mounts || []).map((m) => ({
      type: m.Type,
      source: m.Source,
      destination: m.Destination,
      mode: m.Mode,
      rw: m.RW,
    }));
    health = info.State.Health ? info.State.Health.Status : null;
    networks = Object.keys(info.NetworkSettings.Networks || {});
  } catch (_) {}

  try {
    const rawStats = await withTimeout(
      docker.getContainer(id).stats({ stream: false }),
      5000
    );
    const cpuDelta =
      rawStats.cpu_stats.cpu_usage.total_usage -
      rawStats.precpu_stats.cpu_usage.total_usage;
    const systemDelta =
      rawStats.cpu_stats.system_cpu_usage -
      rawStats.precpu_stats.system_cpu_usage;
    const numCpus = rawStats.cpu_stats.online_cpus || 1;
    const cpuPercent =
      systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;
    const memUsage = rawStats.memory_stats.usage || 0;
    const memLimit = rawStats.memory_stats.limit || 1;
    stats = {
      cpu: parseFloat(cpuPercent.toFixed(1)),
      memUsage: formatBytes(memUsage),
      memPercent: parseFloat(((memUsage / memLimit) * 100).toFixed(1)),
    };
  } catch (_) {}

  res.json({ stats, env, volumes, health, networks });
});

app.get("/api/containers/:id/logs", async (req, res) => {
  const lines = parseInt(req.query.lines) || 100;
  try {
    const stream = await withTimeout(
      docker.getContainer(req.params.id).logs({
        stdout: true,
        stderr: true,
        tail: lines,
        timestamps: false,
      }),
      8000
    );
    const clean = stream
      .toString("utf8")
      .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f]/g, "");
    res.type("text/plain").send(clean);
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

app.get("/api/containers/:id/check-update", async (req, res) => {
  try {
    const info = await withTimeout(
      docker.getContainer(req.params.id).inspect(),
      5000
    );
    const imageName = info.Config.Image;
    const localImage = await withTimeout(
      docker.getImage(info.Image).inspect(),
      5000
    );
    const localDigest =
      localImage.RepoDigests && localImage.RepoDigests[0]
        ? localImage.RepoDigests[0].split("@")[1]
        : null;
    const remoteDigest = await getRemoteDigest(imageName);
    const hasUpdate =
      localDigest && remoteDigest ? localDigest !== remoteDigest : null;
    res.json({ hasUpdate, localDigest, remoteDigest, imageName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/containers/:id/export", async (req, res) => {
  try {
    const info = await withTimeout(
      docker.getContainer(req.params.id).inspect(),
      5000
    );
    const name = info.Name.replace(/^\//, "");
    const image = info.Config.Image;
    const portBindings = info.HostConfig.PortBindings || {};
    const binds = info.HostConfig.Binds || [];
    const env = (info.Config.Env || []).filter(
      (e) =>
        !e.startsWith("PATH=") &&
        !e.startsWith("HOME=") &&
        !e.startsWith("HOSTNAME=")
    );
    const labels = info.Config.Labels || {};
    const restart = info.HostConfig.RestartPolicy?.Name || "no";
    const networks = Object.keys(info.NetworkSettings.Networks || {});

    let yaml = `services:\n  ${name}:\n    image: ${image}\n`;
    yaml += `    container_name: ${name}\n`;
    yaml += `    restart: ${restart}\n`;

    const ports = Object.entries(portBindings).flatMap(([k, v]) =>
      (v || []).map((b) => `${b.HostPort}:${k.split("/")[0]}`)
    );
    if (ports.length) {
      yaml += `    ports:\n`;
      for (const p of ports) yaml += `      - "${p}"\n`;
    }
    if (binds.length) {
      yaml += `    volumes:\n`;
      for (const v of binds) yaml += `      - ${v}\n`;
    }
    if (env.length) {
      yaml += `    environment:\n`;
      for (const e of env) yaml += `      - ${e}\n`;
    }
    const userLabels = Object.entries(labels).filter(
      ([k]) => !k.startsWith("com.docker.")
    );
    if (userLabels.length) {
      yaml += `    labels:\n`;
      for (const [k, v] of userLabels) yaml += `      ${k}: "${v}"\n`;
    }
    const userNets = networks.filter(
      (n) => n !== "bridge" && n !== "host" && n !== "none"
    );
    if (userNets.length) {
      yaml += `    networks:\n`;
      for (const n of userNets) yaml += `      - ${n}\n`;
      yaml += `\nnetworks:\n`;
      for (const n of userNets) yaml += `  ${n}:\n    external: true\n`;
    }

    res.type("text/plain").send(yaml);
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

app.get("/api/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  let stream;
  try {
    stream = await docker.getEvents({ filters: { type: ["container"] } });
    stream.on("data", (chunk) => {
      try {
        const event = JSON.parse(chunk.toString());
        res.write(
          `data: ${JSON.stringify({
            action: event.Action,
            name: event.Actor?.Attributes?.name || "unknown",
            time: event.time,
          })}\n\n`
        );
      } catch (_) {}
    });
    req.on("close", () => {
      stream.destroy();
      res.end();
    });
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

app.post("/api/containers/:id/:action", async (req, res) => {
  const { id, action } = req.params;
  if (!["start", "stop", "restart"].includes(action))
    return res.status(400).json({ error: "Invalid action" });
  try {
    await withTimeout(docker.getContainer(id)[action](), 10000);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(2) + " GB";
}

app.get("/api/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3131;
app.listen(PORT, () =>
  console.log(`Altitude Dashboard running on http://localhost:${PORT}`)
);
