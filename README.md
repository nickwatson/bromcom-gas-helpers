# Bromcom GAS Helpers

Optional helpers that build on top of the [`bromcom-gas`](../gas) Google Apps Script library.

These helpers live in a separate package because their assumptions are
opinionated rather than universal — for example, the timetable helpers assume
a Collections-driven school. Schools that don't use Bromcom Collections need a
different approach (modal aggregation across multiple cycles), which is why
this code is on a separate release track.

## Consumption

GAS has no real package manager. Use whichever fits your project:

1. **Copy the source.** Drop `src/timetables.ts` into your Apps Script
   project's `src/` directory alongside the core `bromcom-gas` source. The
   `Bromcom` namespace merges across files at compile time.
2. **Attach as a clasp library.** Push `gas-helpers/` as its own Apps Script
   project, then in your consumer project add a library reference by Script
   ID.

`bromcom-gas` (the core client) must be present either way — the helpers
depend on namespace types declared there.

## Timetables

```typescript
const client = Bromcom.createClient({ applicationId: "...", applicationSecret: "...", schoolId: 20001 });
const timetables = new Bromcom.TimetableHelper(client);

// Template timetable (from Collection definitions)
const blocks = timetables.getTemplate(123);
const blocks2 = timetables.getStudentTemplate(student);
const blocks3 = timetables.getStaffTemplate(staffMember);

// Live timetable (current lessons, covers, room changes)
const grid = timetables.getLive({ studentId: 123 });
const grid2 = timetables.getLive({ staffId: 456, includeCover: false });
```

**Required endpoints:**

- Template: `CollectionAssociates`, `CollectionTimetables`, `PeriodStructures`, `Staff`, `Locations` (GET)
- Live student: `StudentTimetables`, `PeriodStructures`, `Staff` (GET)
- Live staff: `TimeTable`, `PeriodStructures`, `Staff` (GET)

If any required endpoint is not accessible, an `Error` is thrown with a
message indicating which endpoint is needed.
