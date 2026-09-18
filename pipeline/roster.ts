/**
 * Mock roster: the people on each shop's payroll, by role, shift and skill.
 * Workers are identified by id only; there are no names, because nothing in the
 * twin needs one. Generated from a fixed seed.
 *
 * Crew size follows candystore's revenue for the store the building is — s4
 * Avalon at $5.8M a year carries twelve people, s5 Buford Highway at $685k
 * carries four — and every crew is spread over the three shifts the site
 * declares, because a shop that trades 10:00–20:00 needs someone in before the
 * doors open to take the trailer and pick the morning orders, and someone after
 * they close to cash up.
 *
 * Two skills are gated rather than taught on the floor: `counter` needs a food
 * handler's card and `drive` needs a licence and the store's insurance. The
 * rosters below are deliberately thin on both at the small end — Buford Highway
 * has exactly one of each, and it is the same person — so the
 * single-point-of-failure question has a real answer rather than a rehearsed
 * one.
 */

import { ROLES, type RoleKey } from "../lib/twin/roles";
import type { Roster, Skill, Worker } from "../lib/twin/types";
import { seededRandom } from "../lib/util/random";

export const ROSTER_SEED = 44;

/** Just the fields a roster needs from a site, so the pipeline need not parse a whole Site. */
export interface RosterSite {
  id: string;
  shifts: Array<{ id: string }>;
}

interface Crew {
  role: string;
  skills: Skill[];
  wage: number;
  shift: string;
  type: Worker["type"];
  count: number;
}

function crew(key: RoleKey, shift: string, count: number, type: Worker["type"] = "full-time"): Crew {
  const r = ROLES[key];
  return { role: r.role, skills: [...r.skills], wage: r.wage, shift, type, count };
}

/**
 * Headcount by site. Part-timers are the shop's flex: they cover the Friday and
 * Saturday peaks the hour-of-day shape in lib/twin/demand.ts puts at the end of
 * the week, and they cost 24 hours instead of 40.
 *
 * Midtown, Marietta and Buford Highway have no dedicated receiver — the opener
 * takes the trailer between putting the float in the till and unlocking the
 * door, which is exactly the overlap the twin is built to price.
 */
export const CREWS: Record<string, Crew[]> = {
  // s1, $3.01M. A manager, a lead at each end of the day, one card behind the glass.
  "store-midtown": [
    crew("manager", "mid", 1),
    crew("lead", "open", 1),
    crew("lead", "close", 1),
    crew("confectioner", "mid", 1),
    crew("cashier", "mid", 1, "part-time"),
    crew("cashier", "close", 1, "part-time"),
    crew("stocker", "open", 1),
    crew("driver", "open", 1),
  ],
  // s2, $4.26M. Enough volume to justify a receiver and a second confectioner.
  "store-decatur": [
    crew("manager", "mid", 1),
    crew("lead", "open", 1),
    crew("lead", "close", 1),
    crew("confectioner", "mid", 1),
    crew("confectioner", "close", 1, "part-time"),
    crew("cashier", "mid", 1, "part-time"),
    crew("cashier", "close", 1, "part-time"),
    crew("receiver", "open", 1),
    crew("driver", "open", 1),
  ],
  // s3, $2.42M. The smallest general store: one lead, and the manager opens or closes.
  "store-marietta": [
    crew("manager", "mid", 1),
    crew("lead", "close", 1),
    crew("confectioner", "mid", 1),
    crew("cashier", "mid", 1, "part-time"),
    crew("cashier", "close", 1, "part-time"),
    crew("stocker", "open", 1),
    crew("driver", "open", 1),
  ],
  // s4, $5.78M, the flagship. Three cards behind the glass and a split back door.
  "store-avalon": [
    crew("manager", "mid", 1),
    crew("lead", "open", 1),
    crew("lead", "close", 1),
    crew("confectioner", "mid", 2),
    crew("confectioner", "close", 1, "part-time"),
    crew("cashier", "mid", 2, "part-time"),
    crew("cashier", "close", 1, "part-time"),
    crew("stocker", "open", 1),
    crew("receiver", "open", 1),
    crew("driver", "open", 1),
  ],
  // s5, $685k, dark on Mondays. Four people, and the owner-manager is the only
  // food handler's card and the only insured driver in the building.
  "store-buford": [
    crew("manager", "open", 1),
    crew("cashier", "mid", 1),
    crew("stocker", "mid", 1, "part-time"),
    crew("cashier", "close", 1),
  ],
};

/** "store-midtown" → "MID", the tag that prefixes that shop's worker ids. */
function tagFor(siteId: string): string {
  return siteId.replace(/^store-/, "").slice(0, 3).toUpperCase();
}

/**
 * Build the roster for the committed sites. Takes the sites rather than
 * assuming them so that a crew whose shift id no longer exists, or a new shop
 * with nobody on the payroll, fails the pipeline instead of producing a store
 * the simulator silently cannot staff.
 */
export function buildRoster(sites: RosterSite[]): Roster {
  const rng = seededRandom(ROSTER_SEED);
  const workers: Worker[] = [];
  const tags = new Set<string>();

  for (const site of sites) {
    const crews = CREWS[site.id];
    if (!crews) throw new Error(`No crew defined for site "${site.id}". Add one to CREWS in pipeline/roster.ts.`);
    const shiftIds = new Set(site.shifts.map((s) => s.id));
    const tag = tagFor(site.id);
    if (tags.has(tag)) throw new Error(`Worker id tag "${tag}" is used by two sites; site ids must differ in their first three letters.`);
    tags.add(tag);

    let n = 0;
    for (const c of crews) {
      if (!shiftIds.has(c.shift)) throw new Error(`Site "${site.id}" has no shift "${c.shift}" for its ${c.role}s. Known: ${[...shiftIds].join(", ")}.`);
      for (let i = 0; i < c.count; i++) {
        n++;
        workers.push({
          id: `W-${tag}-${String(n).padStart(3, "0")}`,
          store: site.id,
          role: c.role,
          type: c.type,
          homeShift: c.shift,
          skills: c.skills,
          // A tenth either side of standard, and a wage within a dollar of the
          // role's base: two shops' openers are not interchangeable.
          productivity: Math.round((0.9 + rng() * 0.2) * 100) / 100,
          hourlyRate: Math.round((c.wage + (rng() - 0.5) * 2) * 4) / 4,
          maxWeeklyHours: c.type === "part-time" ? 24 : 40,
        });
      }
    }

    // Both gated skills have to exist somewhere in the building, or the shop
    // cannot serve the case or send the van out at all and every scenario run
    // against it answers the same uninteresting way.
    for (const skill of ["counter", "drive"] as const) {
      const have = workers.filter((w) => w.store === site.id && w.skills.includes(skill));
      if (have.length === 0) throw new Error(`Site "${site.id}" has nobody with the "${skill}" skill; its crew in pipeline/roster.ts needs one.`);
    }
  }

  return { generatedAt: new Date().toISOString(), seed: ROSTER_SEED, workers };
}
