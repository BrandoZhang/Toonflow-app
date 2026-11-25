import { resolve } from "node:path";
import { readDataSource } from "@toonflow/multi-tenant-db";
import { createApp } from "./app";
import { parseDeployment, setDeployment } from "./lib/deployment";
import config from "../../../electrobun.config";

const startTime = Date.now();
const deployment = parseDeployment(process.env);
setDeployment(deployment);
const realPort = Number(process.env.TOONFLOW_SERVER_PORT || 3000);
if (!Number.isInteger(realPort) || realPort < 1 || realPort > 65535) throw new Error("TOONFLOW_SERVER_PORT 必须是 1–65535 之间的整数");
// 源码位于 apps/server/src，生产构建位于 build/server，均从文件位置定位根目录。
const fromSource = import.meta.path.endsWith(".ts");
const appDirectory = resolve(import.meta.dirname, fromSource ? "../../.." : "../..");
const dataDirectory = process.env.TOONFLOW_DATA_DIR ?? resolve(appDirectory, "data");
if (deployment.mode === "cluster") {
  if (deployment.adminPort === realPort) throw new Error("TOONFLOW_ADMIN_PORT 不能与 TOONFLOW_SERVER_PORT 相同");
  if ((await readDataSource(dataDirectory))?.provider !== "mysql") {
    throw new Error(`集群模式必须使用 MySQL 数据源：请在共享数据目录写入 ${resolve(dataDirectory, "multiTenant", "dataSource.json")}，provider 设为 "mysql"。SQLite 无法在多个实例间共享。`);
  }
}
const app = await createApp({
  webRoot: resolve(appDirectory, "build/web"),
  appVersion: config.app.version,
  dataDirectory,
  toolsRoot: resolve(appDirectory, "build/tools"),
  nodesRoot: resolve(appDirectory, "build/nodes"),
  extRoot: resolve(appDirectory, "build/ext"),
  // ACT: 暂不安装内置团队，随团队打包一同恢复。
  // agentsRoot: resolve(appDirectory, "build/agents"),
  skillsRoot: resolve(appDirectory, fromSource ? "packages/skills" : "build/skills"),
});
const { initializeMcpRuntime } = await import("./utils/mcp/runtime");
const { startMobileLinkRuntime } = await import("./utils/mobileLink");
const { creationGateway, startMultiTenantRuntime } = await import("./utils/multiTenant");
await startMultiTenantRuntime(app);
function logStarted() {
  console.log(`[服务启动成功]: http://localhost:${realPort}`);
  console.log(`[部署形态]: ${deployment.mode}，实例 ${deployment.instanceId}`);
  console.log(`[启动耗时]: ${(Date.now() - startTime).toFixed(2)}ms`);
}
if (deployment.mode === "cluster") {
  // 主端口即创作 Web；管理后台只在配置 TOONFLOW_ADMIN_PORT 时单独监听；不启动 MCP 回环与设备互联。
  const { adminPort, adminHost } = deployment;
  creationGateway(app).listen(realPort, (error?: Error) => {
    if (error) throw error;
    logStarted();
  });
  if (adminPort === undefined) console.log("[管理后台]: 未配置 TOONFLOW_ADMIN_PORT，不开放管理后台");
  else app.listen(adminPort, adminHost, (error?: Error) => {
    if (error) throw error;
    console.log(`[管理后台]: http://${adminHost}:${adminPort}`);
  });
} else app.listen(realPort, async (error?: Error) => {
  if (error) throw error;
  await initializeMcpRuntime(app, `http://127.0.0.1:${realPort}`, resolve(appDirectory, fromSource ? "packages/mcp/src/stdio.ts" : "build/mcp/stdio.js"));
  await startMobileLinkRuntime(app).catch(error => console.error("设备互联启动失败：", error));
  logStarted();
});
