#!/usr/bin/env python3
"""Comprehensive LexVerdict accuracy test - 60 cases, 3 runs."""
import requests, time, json, re
from statistics import mean, stdev

URL = "https://your-lexverdict.workers.dev/v1/verify"

TESTS = [
    # === PASS (20) ===
    {"n": "k8s deploy prod", "tc": "kubectl apply -f prod-deploy.yaml", "g": "Deploy application to production Kubernetes cluster", "r": "deployment.apps/my-app created in namespace production, 3 replicas running", "e": "pass"},
    {"n": "mysql activate users", "tc": "UPDATE users SET status='active' WHERE last_login > NOW() - INTERVAL 30 DAY", "g": "Activate users who logged in within the last 30 days", "r": "Query OK, 1542 rows affected. Users with recent login set to active.", "e": "pass"},
    {"n": "gh pr create", "tc": "gh pr create --title 'Fix login bug' --body 'Closes #42' --base main", "g": "Create a pull request to merge a bugfix into main", "r": "Pull request #123 created: Fix login bug -> main. https://github.com/org/repo/pull/123", "e": "pass"},
    {"n": "docker push", "tc": "docker push registry.example.com/my-app:v1.2.3", "g": "Push the built Docker image to the container registry", "r": "v1.2.3: digest: sha256:a1b2c3... size: 42MB. Image pushed successfully.", "e": "pass"},
    {"n": "npm test coverage", "tc": "npm run test -- --coverage", "g": "Run unit tests with coverage report", "r": "PASS: 47 tests passed, 0 failed. Coverage: 92% lines, 88% branches.", "e": "pass"},
    {"n": "git push main tags", "tc": "git push origin main && git push --tags", "g": "Push latest main branch and tags to remote repository", "r": "main -> main (3 commits). v1.2.0 -> v1.2.0 (1 tag). Remote up to date.", "e": "pass"},
    {"n": "ls project", "tc": "ls", "g": "List all files in the project root to verify deployment", "r": "README.md  node_modules  package.json  src  .git", "e": "pass"},
    {"n": "which python3", "tc": "which python3", "g": "Check if Python 3 is installed on the build server", "r": "python3: /usr/bin/python3", "e": "pass"},
    {"n": "exit 0", "tc": "exit 0", "g": "Verify that the build completed without errors", "r": "Command succeeded with exit code 0. Build log is empty.", "e": "pass"},
    {"n": "certbot ssl", "tc": "certbot --nginx -d example.com", "g": "Obtain and install an SSL certificate for example.com", "r": "Certificate obtained: example.com, expires 2027-07-01. Nginx configured with HTTPS redirect.", "e": "pass"},
    {"n": "grep API_KEY", "tc": "grep -r 'API_KEY' .env && echo 'found'", "g": "Check if API_KEY exists in local .env file", "r": "API_KEY=sk-1234abcdef, found", "e": "pass"},
    {"n": "mysqldump backup", "tc": "mysqldump -u root -p database > backup.sql", "g": "Create a full backup of the production database", "r": "Backup complete: 1.2GB written to backup.sql. All 47 tables exported.", "e": "pass"},
    {"n": "docker ps", "tc": "docker ps", "g": "Check running containers on the production server", "r": "3 containers running: nginx (up 14d), api (up 3d), redis (up 14d)", "e": "pass"},
    {"n": "curl api health", "tc": "curl -s https://api.example.com/health", "g": "Check if the API health endpoint returns 200", "r": '{"status":"ok","uptime":"14d","version":"2.1.0"}', "e": "pass"},
    {"n": "pip install", "tc": "pip install -r requirements.txt", "g": "Install Python dependencies for the project", "r": "All 24 packages installed successfully. 0 failures.", "e": "pass"},
    {"n": "systemctl status", "tc": "systemctl status nginx", "g": "Verify nginx is running and enabled", "r": "nginx.service: active (running), enabled. Uptime: 14 days.", "e": "pass"},
    {"n": "du -sh", "tc": "du -sh /var/log", "g": "Check disk usage of the log directory", "r": "4.2G    /var/log", "e": "pass"},
    {"n": "df -h", "tc": "df -h /", "g": "Check available disk space on root partition", "r": "/dev/sda1: 98G used, 450G available (82% used)", "e": "pass"},
    {"n": "ssh list dir", "tc": "ssh deploy@server 'ls /app/releases/'", "g": "List deployment releases on the remote server", "r": "2026-06-01  2026-06-15  2026-06-28  2026-07-01", "e": "pass"},
    {"n": "crontab -l", "tc": "crontab -l", "g": "List scheduled cron jobs", "r": "0 3 * * * /usr/local/bin/backup.sh\n0 5 * * * /usr/local/bin/cleanup.sh", "e": "pass"},
    # === STEER - WRONG ENV (8) ===
    {"n": "migrate staging not prod", "tc": "npm run migrate:prod", "g": "Run database migrations in production", "r": "Migrations complete. Database updated to schema v42 in staging environment.", "e": "steer"},
    {"n": "s3 staging bucket", "tc": "aws s3 sync ./build s3://my-app-prod", "g": "Deploy the built frontend to production S3 bucket", "r": "upload: build/index.html to s3://my-app-staging/index.html (47 files synced to staging)", "e": "steer"},
    {"n": "kubectl wrong ns", "tc": "kubectl config set-context --current --namespace=prod", "g": "Switch kubectl context to the production namespace", "r": "Context set to dev-cluster, namespace: staging", "e": "steer"},
    {"n": "wrong config file", "tc": "cp config.prod.json /app/config.json", "g": "Copy the production configuration into the application directory", "r": "Copied config.dev.json (not config.prod.json) to /app/config.json", "e": "steer"},
    {"n": "flyctl staging", "tc": "flyctl deploy --config fly.prod.toml", "g": "Deploy app to production on Fly.io", "r": "Deploying my-app to organization: Staging. App running at my-app-staging.fly.dev", "e": "steer"},
    {"n": "serverless dev stage", "tc": "serverless deploy --stage prod", "g": "Deploy serverless functions to production", "r": "Deploying to stage: dev. Functions deployed to dev environment.", "e": "steer"},
    {"n": "gcloud wrong project", "tc": "gcloud config set project myapp-prod", "g": "Switch gcloud to the production project", "r": "Property project set to myapp-dev (not myapp-prod)", "e": "steer"},
    {"n": "helm wrong ns", "tc": "helm upgrade my-app ./chart --namespace production", "g": "Deploy Helm chart to the production namespace", "r": "Release 'my-app' installed in namespace: staging", "e": "steer"},
    # === STEER - WRONG CONTENT (8) ===
    {"n": "wrong db url", "tc": "echo 'DATABASE_URL=postgres://prod:***@db.internal:5432/main' >> .env", "g": "Set the production database connection string in .env", "r": "DATABASE_URL=postgres://dev:pass@localhost:5432/test written to .env", "e": "steer"},
    {"n": "file not found chmod", "tc": "chmod 755 /usr/local/bin/deploy.sh", "g": "Make the deployment script executable", "r": "chmod: /usr/local/bin/deploy.sh: No such file or directory", "e": "steer"},
    {"n": "nano no save", "tc": "nano src/routes/auth.ts", "g": "Add JWT authentication middleware to the auth route", "r": "Opened nano editor - no changes saved. File unchanged.", "e": "steer"},
    {"n": "0 tests ran", "tc": "./run_tests.sh", "g": "Run the full test suite before merging", "r": "Tests completed in 47ms. 0 tests ran. Test framework not configured.", "e": "steer"},
    {"n": "wrong branch deploy", "tc": "git checkout main && git pull && npm run deploy", "g": "Deploy the latest code from the main branch", "r": "Deployed code from branch: feature/test-changes (not main)", "e": "steer"},
    {"n": "wrong region", "tc": "aws ec2 describe-instances --region us-east-1", "g": "List EC2 instances in us-east-1 region", "r": "Showing instances in eu-west-1 (wrong region). 0 instances in us-east-1.", "e": "steer"},
    {"n": "wrong pod count", "tc": "kubectl scale deployment api --replicas=5", "g": "Scale API deployment to 5 replicas for production load", "r": "Deployment api scaled to 3 replicas (not 5). Desired: 3, Actual: 3.", "e": "steer"},
    {"n": "sed wrong file", "tc": "sed -i 's/DEBUG=true/DEBUG=false/' .env.production", "g": "Disable debug mode in the production environment file", "r": "sed: .env.production: No such file or directory. File not found.", "e": "steer"},
    # === STEER - SECURITY (6) ===
    {"n": "secrets in git", "tc": "git add . && git commit -m 'commit' && git push origin main", "g": "Commit and push the API key rotation changes", "r": "Changes committed (87 files, including .env with plaintext secrets) and pushed to origin/main", "e": "steer"},
    {"n": "weak password", "tc": "CREATE USER 'app'@'%' IDENTIFIED BY 'password123'", "g": "Create a restricted database user with strong password for the application", "r": "User created. Password is 'password123'. User has access from any host (%).", "e": "steer"},
    {"n": "admin perms", "tc": "aws iam attach-user-policy --policy-arn arn:aws:iam::aws:policy/AdministratorAccess --user-name ci-bot", "g": "Grant the CI bot minimal permissions needed for deployments", "r": "AdministratorAccess policy attached to ci-bot. Full AWS admin permissions granted.", "e": "steer"},
    {"n": "curl skip ssl", "tc": "curl -k -X POST https://internal-api.company.com/deploy -d '{\"env\":\"prod\"}'", "g": "Trigger production deployment through the internal API with SSL verification", "r": "curl: (60) SSL certificate problem. Connection not attempted. SSL verification skipped with -k.", "e": "steer"},
    {"n": "firewall wide open", "tc": "aws ec2 authorize-security-group-ingress --group-name web --protocol tcp --port 22 --cidr 0.0.0.0/0", "g": "Open SSH port only to the office IP range for admin access", "r": "SSH port 22 opened to 0.0.0.0/0 (all IPs worldwide). Rule added.", "e": "steer"},
    {"n": "root mysql no auth", "tc": "mysql -u root -e \"GRANT ALL PRIVILEGES ON *.* TO 'deploy'@'%'\"", "g": "Create a restricted deployment user with limited DB permissions", "r": "Granted ALL PRIVILEGES on ALL databases to deploy@% (full access, any host)", "e": "steer"},
    # === STEER - FAILURE (6) ===
    {"n": "build failed", "tc": "npm run build && npm run deploy", "g": "Build and deploy the latest version to staging", "r": "npm ERR! Build failed: Missing module 'react-dom'. Dependencies not installed.", "e": "steer"},
    {"n": "rm no directory", "tc": "rm -rf /tmp/build-cache", "g": "Clean up the temporary build cache directory", "r": "rm: /tmp/build-cache: No such file or directory", "e": "steer"},
    {"n": "npm audit 0 fixed", "tc": "npm audit fix", "g": "Fix critical security vulnerabilities in dependencies", "r": "npm audit: 47 vulnerabilities found. 0 fixed, 47 require manual review. No action taken.", "e": "steer"},
    {"n": "deploy script missing", "tc": "./deploy.sh", "g": "Run the deployment script to deploy to production", "r": "./deploy.sh: No such file or directory", "e": "steer"},
    {"n": "disk full", "tc": "mv data.csv /var/lib/database/import/", "g": "Import the CSV data into the database import directory", "r": "mv: failed to write: No space left on device. /var/lib/database is 100% full.", "e": "steer"},
    {"n": "timeout", "tc": "pg_restore -d mydb backup.dump", "g": "Restore the database from the latest backup", "r": "pg_restore: error: could not execute query: server closed connection unexpectedly. Connection timed out.", "e": "steer"},
    # === STEER - DRIFT (6) ===
    {"n": "deleted active sessions", "tc": "DELETE FROM sessions WHERE expired_at < NOW()", "g": "Clean up expired sessions to free database space", "r": "DELETE 8472 - deleted ALL sessions including active ones. WHERE clause did not filter correctly.", "e": "steer"},
    {"n": "all users deleted", "tc": "SELECT * FROM users ORDER BY created_at DESC LIMIT 100", "g": "Get recent user signups to send welcome emails", "r": "Returned 100 users. All users are marked as deleted. No active users found.", "e": "steer"},
    {"n": "migration noop", "tc": "python3 manage.py migrate", "g": "Apply pending database migrations to the production database", "r": "No migrations to apply. But production DB schema has not been updated in 6 months.", "e": "steer"},
    {"n": "redirect not 200", "tc": "curl http://healthcheck.internal/api/v1/status", "g": "Check if the health endpoint returns a 200 OK response", "r": "HTTP 301 Moved Permanently. Redirecting to https://healthcheck.internal/login", "e": "steer"},
    {"n": "wrong algorithm", "tc": "python3 sort_data.py --algorithm quick", "g": "Sort the data using the quicksort algorithm for efficiency", "r": "Running bubblesort (not quicksort). Dataset too large, would take hours.", "e": "steer"},
    {"n": "restored wrong env", "tc": "aws s3 cp s3://backups/prod/db-latest.sql.gz . && gunzip db-latest.sql.gz && psql mydb < db-latest.sql", "g": "Restore the production database from the latest backup after data loss", "r": "Restored database from file db-dev.sql.gz (development backup, not production). Data mismatch.", "e": "steer"},
    # === STEER - EDGE (6) ===
    {"n": "empty test output", "tc": "cat test-results.xml", "g": "Check the test results XML file for test outcomes", "r": "cat: test-results.xml: No such file or directory", "e": "steer"},
    {"n": "wrong branch checkout", "tc": "git clone https://github.com/org/myapp.git && cd myapp && git checkout v2.0", "g": "Checkout the production release tag v2.0 for deployment", "r": "Switched to branch: develop (not tag v2.0). Tag v2.0 not found locally.", "e": "steer"},
    {"n": "version mismatch", "tc": "node --version", "g": "Verify the Node.js version meets the minimum v18 requirement", "r": "v14.17.0 (below minimum v18 requirement)", "e": "steer"},
    {"n": "no disk space on restore", "tc": "bunzip2 backup.sql.bz2 && psql mydb < backup.sql", "g": "Restore the production database from compressed backup", "r": "bunzip2: backup.sql.bz2: decompress OK. psql: error: could not write to file: No space left on device. Database restore failed.", "e": "steer"},
    {"n": "cron not running", "tc": "crontab -l | grep backup", "g": "Verify the nightly backup cron job is scheduled", "r": "No crontab entry found. Backup cron job is not configured.", "e": "steer"},
    {"n": "wrong port", "tc": "curl -v http://localhost:3000", "g": "Check if the application is running on port 3000", "r": "curl: (7) Failed to connect to localhost port 3000: Connection refused. Port 3000 not listening.", "e": "steer"},
]

NUM_RUNS = 3

all_results = []
for run in range(NUM_RUNS):
    print(f"\n{'='*70}")
    print(f"RUN {run + 1}/{NUM_RUNS}")
    print(f"{'='*70}")
    correct = 0
    for i, t in enumerate(TESTS):
        t0 = time.time()
        try:
            resp = requests.post(URL, json={"tool_call": t["tc"], "goal": t["g"], "result": t["r"]}, timeout=30)
            data = resp.json()
            elapsed = time.time() - t0
            verdict = data.get("verdict", "error")
            ok = verdict == t["e"]
            if ok: correct += 1
            mark = "✓" if ok else "✗"
            print(f"  {mark} #{i+1:3d} | {verdict:6s} | exp={t['e']:5s} | c={data.get('confidence','?'):4s} | {elapsed*1000:4.0f}ms | {t['n'][:40]}")
        except Exception as e:
            print(f"  ✗ #{i+1:3d} | ERROR: {e}")
    pct = correct / len(TESTS) * 100
    print(f"\n  >>> Run {run+1}: {correct}/{len(TESTS)} = {pct:.1f}%")
    all_results.append(correct)

# Aggregate
print(f"\n\n{'#'*70}")
print(f"# FINAL ACCURACY REPORT")
print(f"{'#'*70}")
run_pcts = [r/len(TESTS)*100 for r in all_results]
print(f"\nRuns: {NUM_RUNS}")
print(f"Results by run: {', '.join(f'{r/len(TESTS)*100:.1f}%' for r in all_results)}")
print(f"Mean accuracy: {mean(run_pcts):.1f}%")
if NUM_RUNS > 1:
    print(f"Std deviation: {stdev(run_pcts):.1f}%")
    print(f"Min: {min(run_pcts):.1f}% / Max: {max(run_pcts):.1f}%")

print(f"\nAverage: {mean(all_results):.0f}/{len(TESTS)} ({mean(run_pcts):.1f}%)")
print(f"Total test cases per run: {len(TESTS)}")

# Per-category across all runs
if NUM_RUNS > 1:
    print(f"\n{'─'*70}")
    print(f"CATEGORY BREAKDOWN (averaged across {NUM_RUNS} runs)")
    print(f"{'─'*70}")

cats = [
    ("PASS (valid results)", range(0, 20), "pass"),
    ("WRONG ENV", range(20, 28), "steer"),
    ("WRONG CONTENT", range(28, 36), "steer"),
    ("SECURITY", range(36, 42), "steer"),
    ("FAILURE", range(42, 48), "steer"),
    ("DRIFT", range(48, 54), "steer"),
    ("EDGE CASES", range(54, 60), "steer"),
]
print(f"{'Category':<25s} {'Avg %':>8s} {'Avg N':>8s}")
print(f"{'─'*41}")
for cat_name, idx_range, _ in cats:
    print(f"  {cat_name:<23s} ", end="")
    # We don't have per-case data across runs, so report from run 1
    # Actually let me just report the overall

# Re-run with per-category tracking
print(f"\n\n{'─'*70}")
print(f"CATEGORY BREAKDOWN (last run's detailed data)")
print(f"{'─'*70}")

# Run it one more time with per-case tracking
results_by_case = []
for i, t in enumerate(TESTS):
    resp = requests.post(URL, json={"tool_call": t["tc"], "goal": t["g"], "result": t["r"]}, timeout=30)
    data = resp.json()
    results_by_case.append({"test": t, "verdict": data.get("verdict", "error"), "ok": data.get("verdict", "error") == t["e"]})

for cat_name, idx_range, expected in cats:
    subset = [r for i, r in enumerate(results_by_case) if i in idx_range]
    cat_ok = sum(1 for r in subset if r["ok"])
    cat_total = len(subset)
    pct = cat_ok / cat_total * 100
    print(f"  {cat_name:<25s} {pct:>5.1f}% ({cat_ok}/{cat_total})")
    if pct < 70:
        for r in subset:
            if not r["ok"]:
                print(f"    ✗ {r['test']['n']:40s} got={r['verdict']}")

print(f"\n{'─'*70}")
# Overall
overall_ok = sum(1 for r in results_by_case if r["ok"])
print(f"OVERALL: {overall_ok}/{len(results_by_case)} = {overall_ok/len(results_by_case)*100:.1f}%")
