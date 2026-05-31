import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_REPO = "shunsuke-chocolate/investment";
const DEFAULT_WORKSPACE_ROOT = process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace";
const DEFAULT_REPO_DIR = path.join(DEFAULT_WORKSPACE_ROOT, "investment-report-runner");
const DEFAULT_BASE_BRANCH = "main";

function usage() {
  return `Usage:
  node scripts/run-investment-codex-report.mjs --report-type daily --date YYYY-MM-DD [--create-pr]
  node scripts/run-investment-codex-report.mjs --report-type weekly --period YYYY-Www [--create-pr]
  node scripts/run-investment-codex-report.mjs --report-type monthly --period YYYY-MM [--create-pr]
  node scripts/run-investment-codex-report.mjs --issue NUMBER [--create-pr]
`;
}

function parseArgs(argv) {
  const args = {
    repo: process.env.INVESTMENT_REPO || DEFAULT_REPO,
    repoDir: process.env.INVESTMENT_REPO_DIR || DEFAULT_REPO_DIR,
    baseBranch: process.env.INVESTMENT_BASE_BRANCH || DEFAULT_BASE_BRANCH,
    createPr: false,
    reportType: "",
    date: "",
    period: "",
    issue: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--repo") args.repo = argv[++i] || "";
    else if (key === "--repo-dir") args.repoDir = argv[++i] || "";
    else if (key === "--base-branch") args.baseBranch = argv[++i] || "";
    else if (key === "--report-type") args.reportType = argv[++i] || "";
    else if (key === "--date") args.date = argv[++i] || "";
    else if (key === "--period") args.period = argv[++i] || "";
    else if (key === "--issue") args.issue = argv[++i] || "";
    else if (key === "--create-pr") args.createPr = true;
    else if (key === "--help" || key === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repo)) {
    throw new Error("Invalid --repo. Expected owner/name.");
  }
  if (!path.isAbsolute(args.repoDir)) {
    throw new Error("--repo-dir must be an absolute path.");
  }
  const resolvedRoot = path.resolve(DEFAULT_WORKSPACE_ROOT);
  const resolvedRepoDir = path.resolve(args.repoDir);
  if (!resolvedRepoDir.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`--repo-dir must be under ${resolvedRoot}`);
  }

  if (args.issue) {
    if (!/^[0-9]+$/.test(args.issue)) throw new Error("--issue must be a number.");
    return args;
  }

  if (!["daily", "weekly", "monthly"].includes(args.reportType)) {
    throw new Error("--report-type must be daily, weekly, or monthly when --issue is not used.");
  }
  if (args.reportType === "daily" && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    throw new Error("--date YYYY-MM-DD is required for daily reports.");
  }
  if (args.reportType === "weekly" && !/^\d{4}-W\d{2}$/.test(args.period)) {
    throw new Error("--period YYYY-Www is required for weekly reports.");
  }
  if (args.reportType === "monthly" && !/^\d{4}-\d{2}$/.test(args.period)) {
    throw new Error("--period YYYY-MM is required for monthly reports.");
  }

  return args;
}

function spawnCapture(cmd, args, opts = {}) {
  const result = childProcess.spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env || process.env,
    encoding: "utf8",
    maxBuffer: opts.maxBuffer || 10 * 1024 * 1024,
  });
  const output = redact(`${result.stdout || ""}${result.stderr || ""}`);
  const displayArgs = args.map((arg) => redact(arg)).join(" ");
  if (result.error) {
    throw new Error(`${cmd} ${displayArgs} failed to start: ${result.error.message}`);
  }
  if ((result.status ?? 0) !== 0 && !opts.allowFailure) {
    throw new Error(`${cmd} ${displayArgs} failed with exit ${result.status}\n${output}`);
  }
  return { code: result.status ?? 0, output };
}

function githubToken() {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.YOAKARI_GITHUB_TOKEN || "";
}

function redact(text) {
  let out = String(text || "");
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (!/(TOKEN|PASSWORD|SECRET|AUTH|KEY)/i.test(key)) continue;
    out = out.split(value).join("***");
  }
  return out;
}

function gitAuthEnv(baseEnv = process.env) {
  const token = githubToken();
  if (!token) return baseEnv;
  const basicAuth = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");

  return {
    ...baseEnv,
    GH_TOKEN: baseEnv.GH_TOKEN || token,
    GITHUB_TOKEN: baseEnv.GITHUB_TOKEN || token,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basicAuth}`,
  };
}

function runLogged(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const log = fs.createWriteStream(opts.logPath, { flags: "a", encoding: "utf8" });
    const append = (chunk) => {
      const text = redact(chunk.toString("utf8"));
      log.write(text);
      tail = `${tail}${text}`.slice(-30_000);
    };
    proc.stdout.on("data", append);
    proc.stderr.on("data", append);
    proc.on("error", (err) => {
      log.end();
      reject(err);
    });
    proc.on("close", (code) => {
      log.end();
      resolve({ code: code ?? 0, tail });
    });
  });
}

function ensureRepo(args) {
  fs.mkdirSync(path.dirname(args.repoDir), { recursive: true });
  const env = gitAuthEnv();
  const repoUrl = `https://github.com/${args.repo}.git`;
  spawnCapture("gh", ["auth", "setup-git"], { allowFailure: true, env });

  if (!fs.existsSync(path.join(args.repoDir, ".git"))) {
    if (fs.existsSync(args.repoDir)) {
      throw new Error(`${args.repoDir} exists but is not a git repository.`);
    }
    spawnCapture("git", ["clone", repoUrl, args.repoDir], { env, maxBuffer: 20 * 1024 * 1024 });
  }

  spawnCapture("git", ["-C", args.repoDir, "remote", "set-url", "origin", repoUrl], { env });
  spawnCapture("git", ["-C", args.repoDir, "fetch", "origin", args.baseBranch], { env, maxBuffer: 20 * 1024 * 1024 });
  spawnCapture("git", ["-C", args.repoDir, "switch", args.baseBranch], { env });
  spawnCapture("git", ["-C", args.repoDir, "reset", "--hard", `origin/${args.baseBranch}`], { env });
  spawnCapture("git", ["-C", args.repoDir, "clean", "-fd", "--", ".report-agent", "reports/insights", "reports/weekly", "reports/monthly"], { env });
}

function runnerArgs(args) {
  const out = [];
  if (args.issue) {
    out.push("--issue", args.issue, "--repo", args.repo);
  } else {
    out.push("--report-type", args.reportType);
    if (args.date) out.push("--date", args.date);
    if (args.period) out.push("--period", args.period);
  }
  if (args.createPr) out.push("--create-pr");
  return out;
}

const args = parseArgs(process.argv.slice(2));
ensureRepo(args);

const logDir = path.join(args.repoDir, ".report-agent");
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `investment-report-run-${Date.now()}.log`);

const env = {
  ...gitAuthEnv(),
  CODEX_HOME: process.env.CODEX_HOME || "/data/.codex",
  CODEX_CMD: process.env.CODEX_CMD || "codex",
  CODEX_SANDBOX: process.env.CODEX_SANDBOX || "danger-full-access",
  GH_REPO: args.repo,
  PYTHON_CMD: process.env.PYTHON_CMD || "python3",
  RUNNER_BASE_BRANCH: args.baseBranch,
};

const command = ["bash", "scripts/run_codex_report.sh", ...runnerArgs(args)];
console.log(`[investment-report] repo=${args.repo}`);
console.log(`[investment-report] cwd=${args.repoDir}`);
console.log(`[investment-report] command=${command.join(" ")}`);
console.log(`[investment-report] log=${logPath}`);

const result = await runLogged(command[0], command.slice(1), {
  cwd: args.repoDir,
  env,
  logPath,
});

console.log(result.tail);
console.log(`[investment-report] exit=${result.code}`);
console.log(`[investment-report] log=${logPath}`);

process.exit(result.code);
