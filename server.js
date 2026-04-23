const express = require("express");
const Docker = require("dockerode");
const path = require("path");

const app = express();
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

app.get("/api/containers", async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });

    const enriched = await Promise.all(
      containers.map(async (c) => {
        let stats = null;
        try {
          if (c.State === "running") {
            const container = docker.getContainer(c.Id);
            const rawStats = await container.stats({ stream: false });
            const cpuDelta =
              rawStats.cpu_stats.cpu_usage.total_usage -
              rawStats.precpu_stats.cpu_usage.total_usage;
            const systemDelta =
              rawStats.cpu_stats.system_cpu_usage -
              rawStats.precpu_stats.system_cpu_usage;
            const numCpus = rawStats.cpu_stats.online_cpus || 1;
            const cpuPercent =
              systemDelta > 0
                ? (cpuDelta / systemDelta) * numCpus * 100
                : 0;
            const memUsage = rawStats.memory_stats.usage || 0;
            const memLimit = rawStats.memory_stats.limit || 1;
            stats = {
              cpu: cpuPercent.toFixed(1),
              memUsage: formatBytes(memUsage),
              memPercent: ((memUsage / memLimit) * 100).toFixed(1),
            };
          }
        } catch (_) {}

        const ports = c.Ports.filter((p) => p.PublicPort).map((p) => ({
          public: p.PublicPort,
          private: p.PrivatePort,
          type: p.Type,
        }));

        const label = c.Labels || {};
        const webUrl =
          label["altitude.url"] ||
          label["homepage.href"] ||
          (ports.length > 0 ? `http://localhost:${ports[0].public}` : null);

        return {
          id: c.Id.slice(0, 12),
          name: c.Names[0].replace(/^\//, ""),
          image: c.Image,
          state: c.State,
          status: c.Status,
          ports,
          webUrl,
          created: c.Created,
          stats,
        };
      })
    );

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/containers/:id/:action", async (req, res) => {
  const { id, action } = req.params;
  const allowed = ["start", "stop", "restart"];
  if (!allowed.includes(action))
    return res.status(400).json({ error: "Invalid action" });

  try {
    const container = docker.getContainer(id);
    await container[action]();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

const PORT = process.env.PORT || 3131;
app.listen(PORT, () => {
  console.log(`Altitude Dashboard running on http://localhost:${PORT}`);
});
