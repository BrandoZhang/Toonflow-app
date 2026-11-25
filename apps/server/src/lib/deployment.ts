import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isModelSecret } from "@toonflow/multi-tenant-models";

export type DeploymentProfile =
  | { mode: "standalone"; instanceId: string }
  | { mode: "cluster"; instanceId: string; adminPort?: number; adminHost: string };

const adminPortMessage = "TOONFLOW_ADMIN_PORT 必须是 1–65535 之间的整数";
const adminHostMessage = "TOONFLOW_ADMIN_HOST 长度必须为 1–255 个字符";
const deploymentSchema = z.object({
  TOONFLOW_DEPLOYMENT: z.enum(["standalone", "cluster"], { error: "TOONFLOW_DEPLOYMENT 只能是 standalone 或 cluster" }).default("standalone"),
  TOONFLOW_INSTANCE_ID: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, "TOONFLOW_INSTANCE_ID 只能包含字母、数字、下划线和短横线，长度为 1–64").optional(),
});
const clusterSchema = z.object({
  // 模型加密读取此密钥时先去除首尾空白，校验保持一致。
  TOONFLOW_MULTI_TENANT_SECRET: z.string({ error: "集群模式必须配置 TOONFLOW_MULTI_TENANT_SECRET" }).trim()
    .refine(isModelSecret, "TOONFLOW_MULTI_TENANT_SECRET 必须是解码后恰好 32 字节的标准 Base64"),
  TOONFLOW_CLUSTER_SECRET: z.string({ error: "集群模式必须配置 TOONFLOW_CLUSTER_SECRET" }).refine(value => {
    const key = Buffer.from(value, "base64");
    return key.length >= 32 && key.toString("base64") === value;
  }, "TOONFLOW_CLUSTER_SECRET 必须是解码后至少 32 字节的标准 Base64"),
  TOONFLOW_ADMIN_PORT: z.coerce.number({ error: adminPortMessage }).int(adminPortMessage).min(1, adminPortMessage).max(65535, adminPortMessage).optional(),
  TOONFLOW_ADMIN_HOST: z.string().min(1, adminHostMessage).max(255, adminHostMessage).default("127.0.0.1"),
});

// ACT: 一个进程一个部署形态，由独立服务入口设置；桌面端与移动端不设置，读取时得到 standalone。
let deployment: DeploymentProfile | undefined;

function parseEnv<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.output<T> {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`部署配置无效：${result.error.issues.map(issue => issue.message).join("；")}`);
  return result.data;
}

export function parseDeployment(env: NodeJS.ProcessEnv): DeploymentProfile {
  const { TOONFLOW_DEPLOYMENT: mode, TOONFLOW_INSTANCE_ID: instanceId = randomUUID() } = parseEnv(deploymentSchema, env);
  if (mode === "standalone") return { mode, instanceId };
  const { TOONFLOW_ADMIN_PORT: adminPort, TOONFLOW_ADMIN_HOST: adminHost } = parseEnv(clusterSchema, env);
  return { mode, instanceId, adminPort, adminHost };
}

export function setDeployment(profile: DeploymentProfile) {
  deployment = profile;
}

export function getDeployment(): DeploymentProfile {
  return deployment ??= { mode: "standalone", instanceId: randomUUID() };
}
