import type { Skill } from "./types";

/**
 * Job roles on a store's payroll, their skills and base wage. Shared by the
 * roster pipeline and by scenarios that add people.
 *
 * Two skills are gated rather than taught on the floor: `counter` needs a food
 * handler's card, `drive` needs a licence and the store's insurance. Both are
 * where a small shop's single points of failure live.
 */
export const ROLES = {
  manager: { role: "Store manager", skills: ["receive", "stock", "counter", "register", "pick", "drive"] as Skill[], wage: 30 },
  lead: { role: "Shift lead", skills: ["receive", "stock", "register", "counter", "pick"] as Skill[], wage: 23 },
  confectioner: { role: "Counter confectioner", skills: ["counter", "register", "stock"] as Skill[], wage: 19.5 },
  cashier: { role: "Cashier", skills: ["register", "stock"] as Skill[], wage: 16.5 },
  stocker: { role: "Stocker", skills: ["stock", "receive"] as Skill[], wage: 17.5 },
  receiver: { role: "Receiver", skills: ["receive", "stock", "pick"] as Skill[], wage: 18.5 },
  driver: { role: "Delivery driver", skills: ["drive", "pick", "stock"] as Skill[], wage: 21 },
} as const;

export type RoleKey = keyof typeof ROLES;
export const ROLE_KEYS = Object.keys(ROLES) as RoleKey[];
