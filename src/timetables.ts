/**
 * Timetable helpers for the Bromcom Partner Data API (Google Apps Script).
 *
 * These helpers live in the `bromcom-gas-helpers` package, separate from the
 * core `bromcom-gas` library, because their assumptions (e.g. a Collections-
 * driven school) are opinionated rather than universal.
 *
 * Consumption: copy this file alongside the core `bromcom-gas` source into
 * your Apps Script project, or attach `bromcom-gas-helpers` as a clasp
 * library by Script ID. Either way, the `Bromcom` namespace merges with the
 * core library at compile time.
 */

namespace Bromcom {

  export interface Slot {
    period: string;
    startTime: string;
    endTime: string;
    className?: string | null;
    room?: string | null;
    staffCode?: string | null;
    teacherId?: number | null;
    isCover?: boolean;
  }

  export interface TimetableBlock {
    validFrom: string;
    validTo: string;
    timetable: Record<string, Record<string, Slot[]>>;
  }

  const TT_DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  function ttParseDate(s: string): Date {
    return new Date(s);
  }

  function ttFormatTime(s: string | null | undefined): string {
    if (!s) return "";
    try {
      const dt = new Date(s);
      if (isNaN(dt.getTime())) return s;
      const h = String(dt.getHours()).padStart(2, "0");
      const m = String(dt.getMinutes()).padStart(2, "0");
      return `${h}:${m}`;
    } catch {
      return s;
    }
  }

  function ttNextWeekday(d: Date): Date {
    const result = new Date(d);
    while (result.getDay() === 0 || result.getDay() === 6) {
      result.setDate(result.getDate() + 1);
    }
    return result;
  }

  function ttMondayOf(d: Date): Date {
    const result = new Date(d);
    const day = result.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    result.setDate(result.getDate() + diff);
    return result;
  }

  function ttAddDays(d: Date, n: number): Date {
    const result = new Date(d);
    result.setDate(result.getDate() + n);
    return result;
  }

  function ttAddWeeks(d: Date, n: number): Date {
    return ttAddDays(d, n * 7);
  }

  function ttDateStr(d: Date): string {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }

  function ttDerivePeriodName(p: PeriodStructures): string {
    if ((p as any).periodDisplayName) return (p as any).periodDisplayName;
    const name = (p as any).calendarModelName ?? "";
    const parts = name.split("_");
    if (parts.length >= 2) {
      const mid = parts[1];
      if (/^\d+$/.test(mid) || mid === "AM" || mid === "PM") return mid;
    }
    return name;
  }

  function ttSortDays(grid: Record<string, Slot[]>): Record<string, Slot[]> {
    const sorted: Record<string, Slot[]> = {};
    const keys = Object.keys(grid).sort(
      (a, b) => (TT_DAY_ORDER.indexOf(a) ?? 99) - (TT_DAY_ORDER.indexOf(b) ?? 99),
    );
    for (const k of keys) {
      sorted[k] = grid[k].sort((a, b) => a.startTime.localeCompare(b.startTime));
    }
    return sorted;
  }

  function ttGetCycleLength(http: BromcomHttp, schoolId?: number): number {
    let periods: PeriodStructures[];
    try {
      periods = http.get(
        "/v2/PeriodStructures",
        schoolId != null ? { schoolId } : undefined,
        PeriodStructures,
      ) as PeriodStructures[];
    } catch (e: any) {
      if (e?.message?.startsWith("HTTP 403:")) {
        throw new Error("Timetables require access to the PeriodStructures endpoint. Ensure your API credentials have the required scope.");
      }
      throw e;
    }
    periods = periods.filter((p: any) => (p as any).calendarTypeName === "PERIOD" || (p as any).calendarTypeName === "SESSION");
    const weekNumbers = new Set(periods.map((p: any) => p.weekNumber).filter(Boolean));
    return Math.max(weekNumbers.size, 1);
  }

  function ttFetchStaffCodes(http: BromcomHttp, staffIds: Set<number>, schoolId?: number): Record<number, string> {
    if (!staffIds.size) return {};
    const staffList = http.get("/v2/Staff", schoolId != null ? { schoolId } : undefined, Staff) as Staff[];
    const result: Record<number, string> = {};
    for (const s of staffList) {
      if (staffIds.has((s as any).staffID) && (s as any).staffCode) result[(s as any).staffID] = (s as any).staffCode;
    }
    return result;
  }

  function ttFetchLocations(http: BromcomHttp, locationIds: Set<number>, schoolId?: number): Record<number, string> {
    if (!locationIds.size) return {};
    const locs = http.get("/v2/Locations", schoolId != null ? { schoolId } : undefined, Locations) as Locations[];
    const result: Record<number, string> = {};
    for (const loc of locs) {
      if (locationIds.has((loc as any).locationID)) {
        const name = (loc as any).roomName ?? (loc as any).locationDescription ?? (loc as any).shortCode ?? "";
        if (name && name.toUpperCase() !== "DEFAULT") result[(loc as any).locationID] = name;
      }
    }
    return result;
  }

  function ttResolveHttp(clientOrHttp: BromcomClient | BromcomHttp): BromcomHttp {
    if (clientOrHttp instanceof BromcomClient) {
      return (clientOrHttp as unknown as { http: BromcomHttp }).http;
    }
    return clientOrHttp;
  }

  export class TimetableHelper {
    private http: BromcomHttp;

    /**
     * Pass either a `BromcomClient` or its underlying `BromcomHttp`:
     *
     *     const client = Bromcom.createClient({ ... });
     *     const timetables = new Bromcom.TimetableHelper(client);
     */
    constructor(clientOrHttp: BromcomClient | BromcomHttp) {
      this.http = ttResolveHttp(clientOrHttp);
    }

    getStudentTemplate(
      student: { personID?: number },
      fromDate?: string | Date,
    ): TimetableBlock[] {
      return this.getTemplate(student.personID!, fromDate);
    }

    getStaffTemplate(
      staff: { staffID?: number },
      fromDate?: string | Date,
    ): TimetableBlock[] {
      return this.getTemplate(staff.staffID!, fromDate);
    }

    getTemplate(
      personId: number,
      fromDate?: string | Date,
      schoolId?: number,
    ): TimetableBlock[] {
      let from: Date;
      if (!fromDate) {
        from = ttNextWeekday(new Date());
      } else if (typeof fromDate === "string") {
        from = ttParseDate(fromDate);
      } else {
        from = fromDate;
      }

      const cycleLength = ttGetCycleLength(this.http, schoolId);
      const windowEnd = ttAddWeeks(from, cycleLength);

      let associates: CollectionAssociates[];
      try {
        associates = this.http.get(
          "/v2/CollectionAssociates",
          { entityFilter: `personID=${personId}`, ...(schoolId != null ? { schoolId } : {}) },
          CollectionAssociates,
        ) as CollectionAssociates[];
      } catch (e: any) {
        if (e?.message?.startsWith("HTTP 403:")) {
          throw new Error("Template timetables require access to the CollectionAssociates endpoint. Ensure your API credentials have the required scope.");
        }
        throw e;
      }

      const active = associates.filter((a: any) => {
        const start = a.startDate ? ttParseDate(a.startDate) : new Date(0);
        const end = a.endDate ? ttParseDate(a.endDate) : new Date(9999, 11, 31);
        return start < windowEnd && end >= from;
      });

      if (!active.length) return [];

      const boundarySet = new Set<number>([from.getTime(), windowEnd.getTime()]);
      for (const a of active) {
        const start = a.startDate ? ttParseDate(a.startDate) : new Date(0);
        const end = a.endDate ? ttParseDate(a.endDate) : new Date(9999, 11, 31);
        if (start > from && start < windowEnd) boundarySet.add(start.getTime());
        const dayAfterEnd = ttAddDays(end, 1);
        if (dayAfterEnd > from && dayAfterEnd < windowEnd) boundarySet.add(dayAfterEnd.getTime());
      }
      const boundaries = Array.from(boundarySet).sort((a, b) => a - b).map((t) => new Date(t));

      const collIds = Array.from(new Set(active.map((a: any) => a.collectionID)));
      const allCt: any[] = [];
      for (const collId of collIds) {
        const ct = this.http.get(
          "/v2/CollectionTimetables",
          { entityFilter: `collectionID=${collId}`, ...(schoolId != null ? { schoolId } : {}) },
          CollectionTimetables,
        ) as CollectionTimetables[];
        for (const t of ct) (t as any)._collectionID = collId;
        allCt.push(...ct);
      }

      const calModelIds = Array.from(new Set(allCt.map((t: any) => t.calendarModelID)));
      const periodMap: Record<number, PeriodStructures[]> = {};
      for (const calId of calModelIds) {
        periodMap[calId] = (this.http.get(
          "/v2/PeriodStructures",
          { entityFilter: `calendarModelID=${calId}`, ...(schoolId != null ? { schoolId } : {}) },
          PeriodStructures,
        ) as PeriodStructures[]).filter((p: any) => (p as any).calendarTypeName === "PERIOD" || (p as any).calendarTypeName === "SESSION");
      }

      const collNames: Record<number, string | null> = {};
      for (const a of active) collNames[(a as any).collectionID] = (a as any).collectionName ?? null;

      // Resolve staff codes and location names
      const staffIds = new Set(allCt.map((t: any) => t.employeeID).filter(Boolean));
      const locationIds = new Set(allCt.map((t: any) => t.locationID).filter(Boolean));
      const staffCodes = ttFetchStaffCodes(this.http, staffIds as Set<number>, schoolId);
      const locationNameMap = ttFetchLocations(this.http, locationIds as Set<number>, schoolId);

      const blocks: TimetableBlock[] = [];
      for (let i = 0; i < boundaries.length - 1; i++) {
        const blockStart = boundaries[i];
        const blockEnd = ttAddDays(boundaries[i + 1], -1);

        const blockColls = new Set<number>();
        for (const a of active) {
          const aStart = a.startDate ? ttParseDate(a.startDate) : new Date(0);
          const aEnd = a.endDate ? ttParseDate(a.endDate) : new Date(9999, 11, 31);
          if (aStart <= blockEnd && aEnd >= blockStart) blockColls.add((a as any).collectionID);
        }

        const timetable: Record<string, Record<string, Slot[]>> = {};
        for (const ct of allCt) {
          if (!blockColls.has(ct._collectionID)) continue;
          const ctStart = ct.startDate ? ttParseDate(ct.startDate) : new Date(0);
          const ctEnd = ct.endDate ? ttParseDate(ct.endDate) : new Date(9999, 11, 31);
          if (ctStart > blockEnd || ctEnd < blockStart) continue;

          const periods = periodMap[ct.calendarModelID] ?? [];
          for (const p of periods) {
            const week = (p as any).weekDisplayName ?? `Week ${(p as any).weekNumber ?? 1}`;
            const day = (p as any).dayOfWeek;
            if (!day) continue;
            if (!timetable[week]) timetable[week] = {};
            if (!timetable[week][day]) timetable[week][day] = [];
            timetable[week][day].push({
              period: ttDerivePeriodName(p),
              startTime: ttFormatTime((p as any).defaultStartTime),
              endTime: ttFormatTime((p as any).defaultEndTime),
              className: collNames[ct._collectionID],
              room: ct.locationID ? (locationNameMap[ct.locationID] ?? null) : null,
              staffCode: ct.employeeID ? (staffCodes[ct.employeeID] ?? null) : null,
              teacherId: ct.employeeID ?? null,
            });
          }
        }

        // Deduplicate and sort
        for (const week of Object.keys(timetable)) {
          for (const day of Object.keys(timetable[week])) {
            const seen = new Set<string>();
            const unique: Slot[] = [];
            for (const s of timetable[week][day]) {
              const key = `${s.startTime}|${s.endTime}|${s.className ?? ""}`;
              if (!seen.has(key)) {
                seen.add(key);
                unique.push(s);
              }
            }
            timetable[week][day] = unique;
          }
          timetable[week] = ttSortDays(timetable[week]);
        }

        if (Object.keys(timetable).length > 0) {
          blocks.push({
            validFrom: ttDateStr(blockStart),
            validTo: ttDateStr(blockEnd),
            timetable,
          });
        }
      }

      return blocks;
    }

    getLive(options: {
      studentId?: number;
      staffId?: number;
      fromDate?: string | Date;
      includeCover?: boolean;
      schoolId?: number;
    }): Record<string, Record<string, Slot[]>> {
      const { studentId, staffId, includeCover = true, schoolId } = options;
      if (studentId == null && staffId == null) {
        throw new Error("Either studentId or staffId must be provided");
      }

      let from: Date;
      if (!options.fromDate) {
        from = ttNextWeekday(new Date());
      } else if (typeof options.fromDate === "string") {
        from = ttParseDate(options.fromDate);
      } else {
        from = options.fromDate;
      }

      const cycleLength = ttGetCycleLength(this.http, schoolId);
      const allEntries: any[] = [];
      const monday = ttMondayOf(from);

      for (let weekIdx = 0; weekIdx < cycleLength; weekIdx++) {
        const weekStart = ttAddWeeks(monday, weekIdx);
        const weekEnd = ttAddDays(weekStart, 4);
        const dateFilter = `periodStartDate >= '${ttDateStr(weekStart)}' and periodStartDate <= '${ttDateStr(weekEnd)}'`;

        if (studentId != null) {
          const filter = `studentID=${studentId} and ${dateFilter}`;
          try {
            const entries = this.http.get(
              "/v2/StudentTimetables",
              { entityFilter: filter, ...(schoolId != null ? { schoolId } : {}) },
              StudentTimetables,
            );
            allEntries.push(...(entries as any[]));
          } catch (e: any) {
            if (e?.message?.startsWith("HTTP 403:")) {
              throw new Error("Live student timetables require access to the StudentTimetables endpoint. Ensure your API credentials have the required scope.");
            }
            throw e;
          }
        } else {
          let filter = `staffID=${staffId} and ${dateFilter}`;
          if (!includeCover) filter += " and isCover=0";
          try {
            const entries = this.http.get(
              "/v2/TimeTable",
              { entityFilter: filter, ...(schoolId != null ? { schoolId } : {}) },
              TimeTable,
            );
            allEntries.push(...(entries as any[]));
          } catch (e: any) {
            if (e?.message?.startsWith("HTTP 403:")) {
              throw new Error("Live staff timetables require access to the TimeTable endpoint. Ensure your API credentials have the required scope.");
            }
            throw e;
          }
        }
      }

      const seen: Record<string, any> = {};
      for (const e of allEntries) {
        const key = `${e.weekDisplayName ?? e.weekNumber ?? "1"}|${e.dayOfWeek}|${e.periodDisplayName ?? ""}`;
        const existing = seen[key];
        if (!existing || (e.periodStartDate ?? "") > (existing.periodStartDate ?? "")) {
          seen[key] = e;
        }
      }

      // Resolve staff codes
      const liveStaffIds = new Set(Object.values(seen).map((e: any) => e.staffID).filter(Boolean));
      const liveStaffCodes = ttFetchStaffCodes(this.http, liveStaffIds as Set<number>, schoolId);

      const timetable: Record<string, Record<string, Slot[]>> = {};
      for (const e of Object.values(seen)) {
        const week = String(e.weekDisplayName ?? e.weekNumber ?? "Week 1");
        const day = e.dayOfWeek;
        if (!day) continue;
        if (!timetable[week]) timetable[week] = {};
        if (!timetable[week][day]) timetable[week][day] = [];
        const rawRoom = e.locationName ?? null;
        const room = rawRoom && rawRoom.toUpperCase() !== "DEFAULT" ? rawRoom : null;
        let clsName = e.className ?? e.classStaffRoom ?? null;
        if (clsName) clsName = clsName.replace(/\r/g, "").replace(/\n/g, " ").trim();
        timetable[week][day].push({
          period: e.periodDisplayName ?? "",
          startTime: ttFormatTime(e.periodStartTime),
          endTime: ttFormatTime(e.periodEndTime),
          className: clsName,
          room,
          staffCode: e.staffID ? (liveStaffCodes[e.staffID] ?? null) : null,
          teacherId: e.staffID ?? null,
          isCover: Boolean(e.isCover),
        });
      }

      for (const week of Object.keys(timetable)) {
        timetable[week] = ttSortDays(timetable[week]);
      }

      return timetable;
    }
  }
}
