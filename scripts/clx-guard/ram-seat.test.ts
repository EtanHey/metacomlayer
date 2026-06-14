import { test, expect, beforeAll } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEAT = join(import.meta.dir, "ram-seat.sh");
let work: string;
let n = 0;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "ram-seat-"));
});
const seatDir = () => join(work, `seat-${n++}`);

test("status is 'free' on a fresh seat", () => {
  const env = { ...process.env, RAM_SEAT_DIR: seatDir() };
  const out = execFileSync("bash", [SEAT, "status"], { env }).toString();
  expect(out).toContain("free");
});

test("run acquires the free seat, executes the command, then releases", () => {
  const dir = seatDir();
  const out = join(work, `ran-${n}.txt`);
  const env = { ...process.env, RAM_SEAT_DIR: dir };
  execFileSync(
    "bash",
    [SEAT, "run", "job", "--", "bash", "-c", `echo done > ${out}`],
    { env },
  );
  expect(readFileSync(out, "utf8").trim()).toBe("done");
  // seat released after the job finished
  expect(execFileSync("bash", [SEAT, "status"], { env }).toString()).toContain(
    "free",
  );
});

test("run BLOCKS while a LIVE holder occupies the seat, then times out (exit 75)", () => {
  const dir = seatDir();
  mkdirSync(join(dir, "holder"), { recursive: true });
  writeFileSync(join(dir, "holder", "pid"), String(process.pid)); // live holder = this test proc
  const env = {
    ...process.env,
    RAM_SEAT_DIR: dir,
    RAM_SEAT_WAIT_SECONDS: "1",
    RAM_SEAT_POLL: "1",
  };
  let code = 0;
  try {
    execFileSync("bash", [SEAT, "run", "blocked", "--", "true"], { env });
  } catch (e: any) {
    code = e.status;
  }
  expect(code).toBe(75); // could not get the seat -> backed off
});

test("run RECLAIMS a seat held by a DEAD holder (crash resilience), then runs", () => {
  const dir = seatDir();
  mkdirSync(join(dir, "holder"), { recursive: true });
  writeFileSync(join(dir, "holder", "pid"), "999999"); // dead pid
  const out = join(work, `reclaim-${n}.txt`);
  const env = {
    ...process.env,
    RAM_SEAT_DIR: dir,
    RAM_SEAT_WAIT_SECONDS: "5",
    RAM_SEAT_POLL: "1",
  };
  expect(() =>
    execFileSync(
      "bash",
      [SEAT, "run", "afterdead", "--", "bash", "-c", `echo ok > ${out}`],
      { env },
    ),
  ).not.toThrow();
  expect(readFileSync(out, "utf8").trim()).toBe("ok");
});

test("holder-pid reports the live holder (guardian reads this to spare the legit job)", () => {
  const dir = seatDir();
  mkdirSync(join(dir, "holder"), { recursive: true });
  writeFileSync(join(dir, "holder", "pid"), "4242");
  const env = { ...process.env, RAM_SEAT_DIR: dir };
  expect(
    execFileSync("bash", [SEAT, "holder-pid"], { env }).toString().trim(),
  ).toBe("4242");
});
