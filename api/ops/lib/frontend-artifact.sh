# shellcheck shell=bash
# Sourced by pht-deploy-frontend.sh. Not executable on its own.
#
# verify_frontend_artifact <dist-dir>
#
# Succeeds only if <dist-dir> is a build of the 98.css page (pht frontend
# `rebuild` and later) and nothing else: prints each failure and returns 1.
# Kept out of the deploy script so tests/frontendArtifact.test.ts can run it
# against real and broken builds without deploying anything.
verify_frontend_artifact() {
  local d="$1" fail=0 bad js head_end csp_line first_res
  _no() { printf '[ARTIFACT] %s\n' "$*" >&2; fail=1; }

  [[ -d "$d" ]] || { _no "missing build output: ${d}"; return 1; }
  [[ -f "${d}/index.html" ]] || { _no "${d}/index.html not found — not a frontend build"; return 1; }
  [[ -d "${d}/assets" ]] || _no "${d}/assets not found — not a frontend build"

  # Cross-contamination guard: these only exist in a BACKEND build.
  for bad in index.js app.js schemas.js routes db middleware coach lib; do
    [[ -e "${d}/${bad}" ]] && _no "${d}/${bad} exists — this looks like a BACKEND build"
  done
  # Never ship an env file or a source map into a public web root.
  if [[ -n "$(find "$d" -name '.env*' -print -quit)" ]]; then _no "an .env file is under ${d}"; fi
  if [[ -n "$(find "$d" -name '*.map' -print -quit)" ]]; then _no "source maps are under ${d}"; fi

  # Exactly one entry bundle, referenced by index.html and present on disk.
  js="$(grep -o 'src="/assets/index-[A-Za-z0-9_-]*\.js"' "${d}/index.html" | sed 's/^src="\///; s/"$//' || true)"
  if [[ "$(printf '%s\n' "$js" | grep -c .)" != "1" ]]; then
    _no "index.html must reference exactly one assets/index-*.js (found: ${js:-none})"
  elif [[ ! -f "${d}/${js}" ]]; then
    _no "index.html references ${js}, which is not in the build"
  fi

  # The Content-Security-Policy meta: present, self-only, and the first thing
  # in <head>, before any script or stylesheet it has to govern.
  csp_line="$(grep -n 'http-equiv="Content-Security-Policy"' "${d}/index.html" | head -1 | cut -d: -f1 || true)"
  if [[ -z "$csp_line" ]]; then
    _no "index.html has no Content-Security-Policy meta"
  else
    local csp
    csp="$(sed -n "${csp_line}p" "${d}/index.html")"
    for want in "default-src 'self'" "script-src 'self'" "style-src 'self'" "connect-src 'self'" "manifest-src 'self'"; do
      [[ "$csp" == *"$want"* ]] || _no "CSP is missing: ${want}"
    done
    [[ "$csp" == *unsafe-* ]] && _no "CSP allows an unsafe-* source"
    first_res="$(grep -nE '<script|<link' "${d}/index.html" | head -1 | cut -d: -f1 || true)"
    [[ -n "$first_res" && "$csp_line" -lt "$first_res" ]] \
      || _no "the CSP meta must come before every <script> and <link>"
  fi
  # No inline script: every <script> tag has a src.
  if grep -E '<script' "${d}/index.html" | grep -vq 'src='; then _no "index.html has an inline <script>"; fi
  # No inline style attributes or <style> blocks in the page.
  if grep -qE '<style|style="' "${d}/index.html"; then _no "index.html has inline styles"; fi

  # 98.css, vendored, with its licences.
  for f in 98.css LICENSE FONT-LICENSE.txt ms_sans_serif.woff2 ms_sans_serif_bold.woff2; do
    [[ -f "${d}/vendor/98css/${f}" ]] || _no "vendor/98css/${f} is missing"
  done
  grep -q 'href="/vendor/98css/98.css"' "${d}/index.html" || _no "index.html does not link /vendor/98css/98.css"
  # The 7-segment font (DSEG, SIL OFL) may only ship with its licence.
  if [[ -n "$(find "$d/vendor/dseg" -name '*.woff2' -print -quit 2>/dev/null)" ]] \
    && [[ ! -f "${d}/vendor/dseg/DSEG-LICENSE.txt" ]]; then
    _no "vendor/dseg has fonts but no DSEG-LICENSE.txt"
  fi

  # The page talks to the API at same-origin /api only. An absolute URL ending
  # in /api in the bundle means a base URL crept back in, and the CSP would
  # block it in production anyway.
  if grep -rqsE 'https?://[^"'"'"'`[:space:]]*/api' "${d}/assets"; then
    _no "the bundle contains an absolute API URL — it must call same-origin /api"
  fi

  # Installable on a phone: the manifest, linked, with the fields iOS and
  # Chrome read, and its icons present as PNGs of the stated size.
  if [[ ! -f "${d}/manifest.webmanifest" ]]; then
    _no "manifest.webmanifest is missing"
  else
    local mf
    mf="$(tr -d '[:space:]' < "${d}/manifest.webmanifest")"
    for want in '"name":"PHT"' '"short_name":"PHT"' '"display":"standalone"' '"start_url":"/"' \
      '"theme_color":"#000080"' '"background_color":"#008080"'; do
      [[ "$mf" == *"$want"* ]] || _no "manifest.webmanifest lacks ${want}"
    done
  fi
  grep -q 'rel="manifest" href="/manifest.webmanifest"' "${d}/index.html" || _no "index.html does not link the manifest"
  grep -q 'rel="apple-touch-icon" href="/icons/apple-touch-icon.png"' "${d}/index.html" \
    || _no "index.html has no apple-touch-icon link"
  grep -q 'name="apple-mobile-web-app-capable" content="yes"' "${d}/index.html" \
    || _no "index.html lacks apple-mobile-web-app-capable"
  local icon size w
  for icon in apple-touch-icon.png:180 icon-192.png:192 icon-512.png:512; do
    size="${icon#*:}"
    icon="${d}/icons/${icon%%:*}"
    if [[ ! -f "$icon" ]]; then
      _no "${icon#"${d}/"} is missing"
    elif [[ "$(head -c 8 "$icon" | od -An -tx1 | tr -d ' \n')" != "89504e470d0a1a0a" ]]; then
      _no "${icon#"${d}/"} is not a PNG"
    else
      w="$(od -An -tu1 -j16 -N4 "$icon" | awk '{print $1*16777216 + $2*65536 + $3*256 + $4}')"
      [[ "$w" == "$size" ]] || _no "${icon#"${d}/"} is ${w}px wide, expected ${size}"
    fi
  done
  # No service worker: nothing may cache the app or the API behind our back.
  # Exact names only: hashed bundle names are random and can contain "sw".
  if [[ -n "$(find "$d" \( -name 'sw.js' -o -iname 'service-worker*' -o -iname 'serviceworker*' \
    -o -name 'workbox-*' \) -print | head -1)" ]]; then
    _no "a service worker file is in the build"
  fi

  # A legacy React build must never go out under the new page's name.
  if grep -rqs 'react-dom' "${d}/assets"; then _no "the bundle contains react-dom — this is the legacy React build"; fi

  return "$fail"
}
