import conf from "@/utils/conf";
import { getDeployment } from "@/lib/deployment";

export const creationPort = 10888;

export function isEnabled() { return getDeployment().mode === "cluster" || conf.get("settings", {}).multiTenantEnabled === true; }
