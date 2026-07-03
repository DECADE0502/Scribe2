// 停止服务(由 停止.bat 调起,也可直接 node scripts/stop.mjs):按端口找 PID 并结束。
import { execSync, spawnSync } from "node:child_process";

const PORT = Number(process.env.SCRIBE_PORT ?? 8787);
let found = false;
try {
  const out = execSync("netstat -ano -p tcp", { encoding: "utf8" });
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (line.includes(`:${PORT} `) && /LISTENING/i.test(line)) {
      const pid = line.trim().split(/\s+/).at(-1);
      if (pid && /^\d+$/.test(pid)) pids.add(pid);
    }
  }
  for (const pid of pids) {
    found = true;
    const res = spawnSync("taskkill", ["/f", "/pid", pid]);
    console.log(
      res.status === 0
        ? `已结束占用端口 ${PORT} 的服务进程(PID ${pid})`
        : `结束 PID ${pid} 失败,请手动在任务管理器处理`,
    );
  }
} catch (e) {
  console.error(`查询端口占用失败:${e instanceof Error ? e.message : String(e)}`);
}
if (!found) console.log(`端口 ${PORT} 上没有在运行的服务,无需停止。`);
