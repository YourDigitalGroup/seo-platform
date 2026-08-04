<?php
/**
 * Plugin Name: 44i SEO Platform Connector
 * Description: Securely receives SEO metadata, JSON-LD schema, and content from the 44i SEO platform — one item at a time via REST, or everything at once via a deploy-package file (Settings → SEO Platform → Import package). SEO-ONLY — it never changes your site's appearance, theme, layout, menus, or visual settings. Unapproved content arrives as drafts; approved content publishes on its schedule.
 * Version: 1.2.1
 * Author: 44i Digital
 * License: GPL-2.0+
 */

if (!defined('ABSPATH')) exit;

define('SEOP_NS', 'seo-platform/v1');
define('SEOP_KEY_OPT', 'seoplatform_api_key');
define('SEOP_VERSION', '1.2.1');
// v1.2: built-in AI auto-fix (fills MISSING SEO titles/descriptions and image
// alts site-wide using the Anthropic API; never overwrites existing values).
define('SEOP_OPT_AI_KEY',    'seoplatform_anthropic_key');
define('SEOP_OPT_AI_CRON',   'seoplatform_ai_cron');
define('SEOP_OPT_AI_REPORT', 'seoplatform_ai_last_report');
define('SEOP_AI_MODEL', 'claude-haiku-4-5');
// Site-wide artifacts from a deploy package live in options:
define('SEOP_OPT_ROBOTS',    'seoplatform_robots_txt');
define('SEOP_OPT_LLMS',      'seoplatform_llms_txt');
define('SEOP_OPT_REDIRECTS', 'seoplatform_redirects');      // [{from,to,code}]
define('SEOP_OPT_HEADERS',   'seoplatform_sec_headers');    // {Header-Name: value}
define('SEOP_OPT_SITE_SCHEMA','seoplatform_site_schema');   // JSON-LD strings for the front page
define('SEOP_OPT_LAST_IMPORT','seoplatform_last_import');   // report of the last package import

/* Generate a per-site API key on activation. */
register_activation_hook(__FILE__, function () {
    if (!get_option(SEOP_KEY_OPT)) {
        add_option(SEOP_KEY_OPT, wp_generate_password(48, false, false));
    }
});

/* Auth: constant-time Bearer-token check against this site's key. */
function seop_authed($request) {
    $key = get_option(SEOP_KEY_OPT);
    if (!$key) return false;
    $hdr = $request->get_header('authorization');
    if (!$hdr || stripos($hdr, 'Bearer ') !== 0) return false;
    return hash_equals($key, trim(substr($hdr, 7)));
}

/* Detect the active SEO plugin so we write to the correct meta keys. */
function seop_seo_plugin() {
    if (defined('WPSEO_VERSION')) return 'yoast';
    if (defined('RANK_MATH_VERSION') || class_exists('RankMath')) return 'rankmath';
    return 'none';
}

add_action('rest_api_init', function () {
    $auth = 'seop_authed';
    register_rest_route(SEOP_NS, '/status',   ['methods' => 'GET',  'permission_callback' => $auth, 'callback' => 'seop_status']);
    register_rest_route(SEOP_NS, '/content',  ['methods' => 'POST', 'permission_callback' => $auth, 'callback' => 'seop_content']);
    register_rest_route(SEOP_NS, '/seo-meta', ['methods' => 'POST', 'permission_callback' => $auth, 'callback' => 'seop_seo_meta']);
    register_rest_route(SEOP_NS, '/schema',   ['methods' => 'POST', 'permission_callback' => $auth, 'callback' => 'seop_schema']);
    // v1.1: the whole deploy package in one call (same JSON as the file upload).
    register_rest_route(SEOP_NS, '/package',  ['methods' => 'POST', 'permission_callback' => $auth, 'callback' => 'seop_package_rest']);
    // v1.2: trigger the AI auto-fix remotely (platform-initiated runs).
    register_rest_route(SEOP_NS, '/ai-autofix', ['methods' => 'POST', 'permission_callback' => $auth, 'callback' => function () {
        $r = seop_ai_autofix();
        return is_wp_error($r) ? $r : $r;
    }]);
});

/* Weekly self-healing: cron re-runs the auto-fix so NEW pages get metas too. */
add_action('seop_ai_autofix_event', 'seop_ai_autofix');
register_deactivation_hook(__FILE__, function () { wp_clear_scheduled_hook('seop_ai_autofix_event'); });

function seop_status() {
    return [
        'ok' => true,
        'connector_version' => SEOP_VERSION,
        'wp_version' => get_bloginfo('version'),
        'seo_plugin' => seop_seo_plugin(),
        'site' => home_url(),
        'last_import' => get_option(SEOP_OPT_LAST_IMPORT) ?: null,
    ];
}

/* Find a post we previously created for this external id (so re-pushes update, not duplicate). */
function seop_find_by_external($external_id) {
    if (!$external_id) return 0;
    $ids = get_posts([
        'post_type' => ['post', 'page'], 'post_status' => 'any', 'numberposts' => 1,
        'meta_key' => '_seoplatform_external_id', 'meta_value' => $external_id, 'fields' => 'ids',
    ]);
    return $ids ? (int) $ids[0] : 0;
}

/* Resolve a target (numeric post id or a URL) to a post id. */
function seop_resolve_target($target) {
    if (is_numeric($target)) return (int) $target;
    if (is_string($target) && $target !== '') {
        $id = url_to_postid($target);
        if ($id) return $id;
        // The homepage often isn't a "page" (latest-posts front) — flag it.
        $norm = untrailingslashit(strtolower(preg_replace('#^https?://(www\.)?#', '', $target)));
        $home = untrailingslashit(strtolower(preg_replace('#^https?://(www\.)?#', '', home_url())));
        if ($norm === $home) {
            $front = (int) get_option('page_on_front');
            return $front ?: -1; // -1 = "the front page, but not a page post" (site-wide slot)
        }
    }
    return 0;
}

/* Write SEO title/description/canonical to the active SEO plugin's fields. No visible change. */
function seop_write_meta($post_id, $title, $desc, $canonical) {
    $plugin = seop_seo_plugin();
    if ($title !== null && $title !== '') {
        $title = sanitize_text_field($title);
        if ($plugin === 'yoast')        update_post_meta($post_id, '_yoast_wpseo_title', $title);
        elseif ($plugin === 'rankmath') update_post_meta($post_id, 'rank_math_title', $title);
        update_post_meta($post_id, '_seoplatform_seo_title', $title);
    }
    if ($desc !== null && $desc !== '') {
        $desc = sanitize_text_field($desc);
        if ($plugin === 'yoast')        update_post_meta($post_id, '_yoast_wpseo_metadesc', $desc);
        elseif ($plugin === 'rankmath') update_post_meta($post_id, 'rank_math_description', $desc);
        update_post_meta($post_id, '_seoplatform_seo_desc', $desc);
    }
    if ($canonical !== null && $canonical !== '') {
        $canonical = esc_url_raw($canonical);
        if ($plugin === 'yoast')        update_post_meta($post_id, '_yoast_wpseo_canonical', $canonical);
        elseif ($plugin === 'rankmath') update_post_meta($post_id, 'rank_math_canonical_url', $canonical);
    }
}

/* Create/update a content item. status: draft (default) | publish | future(+date). */
function seop_upsert_content($p) {
    $title   = isset($p['title']) ? sanitize_text_field($p['title']) : '';
    $content = isset($p['content']) ? wp_kses_post($p['content']) : '';
    $excerpt = isset($p['excerpt']) ? sanitize_text_field($p['excerpt']) : '';
    $type    = (isset($p['post_type']) && $p['post_type'] === 'page') ? 'page' : 'post';
    $status  = isset($p['status']) && in_array($p['status'], ['publish', 'draft', 'future'], true) ? $p['status'] : 'draft';
    $external = isset($p['external_id']) ? sanitize_text_field($p['external_id']) : '';
    if ($title === '' && $content === '') {
        return new WP_Error('seop_empty', 'title or content required', ['status' => 400]);
    }
    $data = [
        'post_title' => $title, 'post_content' => $content, 'post_excerpt' => $excerpt,
        'post_status' => $status, 'post_type' => $type,
    ];
    if (!empty($p['slug'])) $data['post_name'] = sanitize_title($p['slug']);
    if ($status === 'future') {
        $gmt = isset($p['schedule']) ? strtotime($p['schedule']) : 0;
        if (!$gmt || $gmt <= time()) { $gmt = time() + 300; } // past date → 5 min from now
        $data['post_date_gmt'] = gmdate('Y-m-d H:i:s', $gmt);
        $data['post_date']     = get_date_from_gmt($data['post_date_gmt']);
    }
    $existing = seop_find_by_external($external);
    if ($existing) { $data['ID'] = $existing; $id = wp_update_post($data, true); }
    else           { $id = wp_insert_post($data, true); }
    if (is_wp_error($id)) return $id;
    if ($external) update_post_meta($id, '_seoplatform_external_id', $external);
    if (!empty($p['focus_keyword'])) update_post_meta($id, '_seoplatform_focus_keyword', sanitize_text_field($p['focus_keyword']));
    if (!empty($p['seo_title']) || !empty($p['seo_description'])) {
        seop_write_meta($id, $p['seo_title'] ?? null, $p['seo_description'] ?? null, null);
    }
    return ['ok' => true, 'post_id' => $id, 'status' => $status,
        'edit_url' => admin_url('post.php?post=' . $id . '&action=edit'),
        'view_url' => get_permalink($id)];
}

/* REST: single content item (kept for per-item pushes from the platform). */
function seop_content($request) {
    $p = $request->get_json_params();
    // publish is opt-in; anything unrecognized lands as draft
    if (isset($p['status']) && !in_array($p['status'], ['publish', 'draft', 'future'], true)) $p['status'] = 'draft';
    return seop_upsert_content($p);
}

function seop_seo_meta($request) {
    $p = $request->get_json_params();
    $id = seop_resolve_target($p['target'] ?? '');
    if ($id <= 0) return new WP_Error('seop_target', 'could not resolve target page', ['status' => 404]);
    seop_write_meta($id, $p['seo_title'] ?? null, $p['seo_description'] ?? null, $p['canonical'] ?? null);
    return ['ok' => true, 'post_id' => $id, 'seo_plugin' => seop_seo_plugin()];
}

/* Store JSON-LD for a page (or site-wide when the target is the front page). */
function seop_store_schema($target, $jsonld) {
    if (is_array($jsonld) || is_object($jsonld)) $jsonld = wp_json_encode($jsonld);
    if (!is_string($jsonld) || json_decode($jsonld) === null) {
        return new WP_Error('seop_jsonld', 'invalid JSON-LD', ['status' => 400]);
    }
    $id = seop_resolve_target($target);
    if ($id > 0) {
        // Multiple blocks per page: keep a list; legacy single-key stays readable.
        $list = get_post_meta($id, '_seoplatform_schema_list', true);
        $list = is_array($list) ? $list : [];
        $list[md5($jsonld)] = wp_slash($jsonld); // hash key = idempotent re-import
        update_post_meta($id, '_seoplatform_schema_list', $list);
        return ['ok' => true, 'post_id' => $id];
    }
    if ($id === -1) { // front page without a page post → site-wide option
        $list = get_option(SEOP_OPT_SITE_SCHEMA, []);
        $list = is_array($list) ? $list : [];
        $list[md5($jsonld)] = $jsonld;
        update_option(SEOP_OPT_SITE_SCHEMA, $list);
        return ['ok' => true, 'site_wide' => true];
    }
    return new WP_Error('seop_target', 'could not resolve target page', ['status' => 404]);
}

function seop_schema($request) {
    $p = $request->get_json_params();
    $res = seop_store_schema($p['target'] ?? '', $p['jsonld'] ?? null);
    if (is_wp_error($res)) {
        // preserve v1.0 behavior: single blob on the resolved post
        $id = seop_resolve_target($p['target'] ?? '');
        if ($id > 0 && is_string($p['jsonld'] ?? null)) {
            update_post_meta($id, '_seoplatform_schema', wp_slash($p['jsonld']));
            return ['ok' => true, 'post_id' => $id];
        }
    }
    return $res;
}

/* ── Head output: schema (legacy single + list + site-wide) and OG tags ── */
add_action('wp_head', function () {
    if (is_front_page()) {
        foreach ((array) get_option(SEOP_OPT_SITE_SCHEMA, []) as $blob) {
            if (is_string($blob) && $blob) echo "\n<script type=\"application/ld+json\">" . $blob . "</script>\n";
        }
    }
    if (!is_singular()) return;
    $pid = get_queried_object_id();
    $legacy = get_post_meta($pid, '_seoplatform_schema', true);
    if ($legacy) echo "\n<script type=\"application/ld+json\">" . $legacy . "</script>\n";
    foreach ((array) get_post_meta($pid, '_seoplatform_schema_list', true) as $blob) {
        if (is_string($blob) && $blob) echo "\n<script type=\"application/ld+json\">" . $blob . "</script>\n";
    }
    $og = get_post_meta($pid, '_seoplatform_og_tags', true);
    if ($og) echo "\n" . $og . "\n"; // sanitized to <meta> tags only at import time
}, 20);

/* ── Site-wide appliers from the deploy package ── */
// robots.txt (only when WP serves it, i.e. no physical file exists)
add_filter('robots_txt', function ($output) {
    $custom = get_option(SEOP_OPT_ROBOTS);
    return $custom ? $custom : $output;
}, 20);

// /llms.txt + 301 redirects
add_action('template_redirect', function () {
    $uri = isset($_SERVER['REQUEST_URI']) ? wp_parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) : '';
    if ($uri === '/llms.txt') {
        $body = get_option(SEOP_OPT_LLMS);
        if ($body) { header('Content-Type: text/plain; charset=utf-8'); echo $body; exit; }
    }
    $rules = get_option(SEOP_OPT_REDIRECTS, []);
    if (is_array($rules) && $uri) {
        $path = untrailingslashit($uri) ?: '/';
        foreach ($rules as $r) {
            $from = untrailingslashit(wp_parse_url($r['from'] ?? '', PHP_URL_PATH) ?: ($r['from'] ?? '')) ?: '/';
            if ($from !== '/' && strcasecmp($from, $path) === 0 && !empty($r['to'])) {
                wp_redirect(esc_url_raw($r['to']), (int) ($r['code'] ?? 301));
                exit;
            }
        }
    }
}, 1);

// Security headers (applies when PHP serves the page; server-level rules still win)
add_action('send_headers', function () {
    foreach ((array) get_option(SEOP_OPT_HEADERS, []) as $name => $value) {
        if (preg_match('/^[A-Za-z0-9-]+$/', $name) && is_string($value) && !headers_sent()) {
            header($name . ': ' . preg_replace('/[\r\n]/', '', $value));
        }
    }
});

/* ── The one-file package importer (shared by file upload + REST /package) ── */
function seop_sanitize_og_block($html) {
    // Keep ONLY <meta ...> tags — nothing executable survives.
    preg_match_all('/<meta\b[^>]*>/i', (string) $html, $m);
    $out = [];
    foreach ($m[0] as $tag) {
        if (stripos($tag, 'http-equiv') !== false) continue;
        $out[] = wp_kses($tag, ['meta' => ['property' => true, 'name' => true, 'content' => true]]);
    }
    return implode("\n", array_filter($out));
}
function seop_parse_header_lines($raw) {
    // Reads `Header always set X "Y"` (Apache) and `add_header X "Y" always;` (nginx) lines.
    $headers = [];
    foreach (preg_split('/\r?\n/', (string) $raw) as $line) {
        if (preg_match('/Header\s+(?:always\s+)?set\s+([A-Za-z0-9-]+)\s+"([^"]+)"/i', $line, $m)) $headers[$m[1]] = $m[2];
        elseif (preg_match('/add_header\s+([A-Za-z0-9-]+)\s+"([^"]+)"/i', $line, $m)) $headers[$m[1]] = $m[2];
    }
    return $headers;
}
function seop_apply_package($pkg) {
    if (!is_array($pkg) || ($pkg['format'] ?? '') !== '44i-deploy-package') {
        return new WP_Error('seop_format', 'not a 44i-deploy-package file', ['status' => 400]);
    }
    $r = ['applied' => [], 'skipped' => [], 'manual' => []];
    $ok = function ($what) use (&$r) { $r['applied'][] = $what; };
    $skip = function ($what, $why) use (&$r) { $r['skipped'][] = $what . ' — ' . $why; };

    foreach ((array) ($pkg['seo_meta'] ?? []) as $m) {
        $id = seop_resolve_target($m['target'] ?? '');
        if ($id > 0) { seop_write_meta($id, $m['seo_title'] ?? null, $m['seo_description'] ?? null, $m['canonical'] ?? null); $ok('SEO meta → ' . ($m['target'] ?? '')); }
        else $skip('SEO meta ' . ($m['target'] ?? ''), $id === -1 ? 'front page has no editable page — set a static front page' : 'target not found');
    }
    foreach ((array) ($pkg['schema'] ?? []) as $s) {
        $res = seop_store_schema($s['target'] ?? '', $s['jsonld'] ?? null);
        if (is_wp_error($res)) $skip('Schema ' . ($s['target'] ?? ''), $res->get_error_message());
        else $ok('JSON-LD schema → ' . ($s['target'] ?? ''));
    }
    foreach ((array) ($pkg['og_tags'] ?? []) as $o) {
        $id = seop_resolve_target($o['target'] ?? '');
        $clean = seop_sanitize_og_block($o['html'] ?? '');
        if ($id > 0 && $clean) { update_post_meta($id, '_seoplatform_og_tags', $clean); $ok('OG/social tags → ' . ($o['target'] ?? '')); }
        else $skip('OG tags ' . ($o['target'] ?? ''), $id <= 0 ? 'target not found' : 'no valid meta tags');
    }
    $files = (array) ($pkg['site_files'] ?? []);
    if (!empty($files['robots_txt'])) {
        if (file_exists(ABSPATH . 'robots.txt')) $skip('robots.txt', 'a physical robots.txt exists — replace it on the server');
        else { update_option(SEOP_OPT_ROBOTS, sanitize_textarea_field($files['robots_txt'])); $ok('robots.txt (served by WordPress)'); }
    }
    if (!empty($files['llms_txt'])) { update_option(SEOP_OPT_LLMS, sanitize_textarea_field($files['llms_txt'])); $ok('llms.txt (served at /llms.txt)'); }
    if (!empty($files['sitemap_xml'])) $r['manual'][] = 'Sitemap: prefer your SEO plugin\'s sitemap (Yoast/Rank Math serve one automatically); the package includes a fallback file if you need it.';
    $rules = (array) (($pkg['redirects']['rules'] ?? []) ?: []);
    if ($rules) {
        $cleanRules = [];
        foreach ($rules as $rule) if (!empty($rule['from']) && !empty($rule['to'])) $cleanRules[] = ['from' => sanitize_text_field($rule['from']), 'to' => esc_url_raw($rule['to']), 'code' => 301];
        $existing = (array) get_option(SEOP_OPT_REDIRECTS, []);
        update_option(SEOP_OPT_REDIRECTS, array_values(array_unique(array_merge($existing, $cleanRules), SORT_REGULAR)));
        $ok(count($cleanRules) . ' redirect rule(s)');
    }
    if (!empty($pkg['redirects']['raw']) && !$rules) $r['manual'][] = 'Redirects: the package includes server rules (.htaccess/nginx) that need to be applied at the server level.';
    if (!empty($pkg['security_headers']['raw'])) {
        $headers = seop_parse_header_lines($pkg['security_headers']['raw']);
        if ($headers) { update_option(SEOP_OPT_HEADERS, $headers); $ok(count($headers) . ' security header(s) (sent by WordPress)'); }
        else $skip('Security headers', 'no parseable header lines');
    }
    $scheduled = 0; $drafted = 0;
    foreach ((array) ($pkg['content'] ?? []) as $cItem) {
        $status = ($cItem['status'] ?? '') === 'schedule' ? 'future' : ((($cItem['status'] ?? '') === 'publish') ? 'publish' : 'draft');
        $res = seop_upsert_content([
            'title' => $cItem['title'] ?? '', 'content' => $cItem['body_html'] ?? '',
            'post_type' => $cItem['post_type'] ?? 'post', 'status' => $status,
            'schedule' => $cItem['schedule'] ?? null, 'external_id' => $cItem['external_id'] ?? '',
            'focus_keyword' => $cItem['focus_keyword'] ?? '', 'slug' => $cItem['slug'] ?? '',
            'seo_title' => $cItem['seo_title'] ?? '', 'seo_description' => $cItem['seo_description'] ?? '',
        ]);
        if (is_wp_error($res)) $skip('Content "' . ($cItem['title'] ?? '?') . '"', $res->get_error_message());
        else { $status === 'future' ? $scheduled++ : $drafted++; }
    }
    if ($scheduled) $ok($scheduled . ' post(s)/page(s) scheduled');
    if ($drafted)   $ok($drafted . ' draft(s) created for review');
    foreach ((array) ($pkg['manual_tasks'] ?? []) as $t) {
        $r['manual'][] = sanitize_text_field(($t['title'] ?? '') . ': ') . sanitize_textarea_field(mb_substr((string) ($t['action'] ?? ''), 0, 400));
    }
    $r['ok'] = true; $r['imported_at'] = current_time('mysql');
    $r['source'] = ['site' => sanitize_text_field($pkg['site'] ?? ''), 'generated_at' => sanitize_text_field($pkg['generated_at'] ?? '')];
    update_option(SEOP_OPT_LAST_IMPORT, $r);
    return $r;
}
function seop_package_rest($request) {
    return seop_apply_package($request->get_json_params());
}

/* ── v1.2: built-in AI auto-fix ───────────────────────────────────────────────
 * Uses the Anthropic API (key stored in options, entered by the agency) to
 * fill in MISSING SEO titles, meta descriptions, and image alt text across
 * the whole site. It never overwrites a value that already exists, batches
 * work to keep each run cheap and fast, and records a report. Runs from the
 * settings button, the weekly cron, or the /ai-autofix REST endpoint. */
function seop_claude($system, $user, $max = 600) {
    $key = get_option(SEOP_OPT_AI_KEY);
    if (!$key) return new WP_Error('seop_ai', 'no Anthropic API key configured');
    $r = wp_remote_post('https://api.anthropic.com/v1/messages', [
        'timeout' => 60,
        'headers' => ['x-api-key' => $key, 'anthropic-version' => '2023-06-01', 'content-type' => 'application/json'],
        'body' => wp_json_encode(['model' => SEOP_AI_MODEL, 'max_tokens' => $max, 'system' => $system,
            'messages' => [['role' => 'user', 'content' => $user]]]),
    ]);
    if (is_wp_error($r)) return $r;
    if (wp_remote_retrieve_response_code($r) !== 200) {
        return new WP_Error('seop_ai', 'Anthropic ' . wp_remote_retrieve_response_code($r) . ': ' . substr((string) wp_remote_retrieve_body($r), 0, 160));
    }
    $body = json_decode(wp_remote_retrieve_body($r), true);
    $text = '';
    foreach ((array) ($body['content'] ?? []) as $b) if (($b['type'] ?? '') === 'text') $text .= $b['text'];
    return trim($text);
}
function seop_existing_meta($post_id) {
    $plugin = seop_seo_plugin();
    $t = get_post_meta($post_id, '_seoplatform_seo_title', true);
    if (!$t && $plugin === 'yoast')    $t = get_post_meta($post_id, '_yoast_wpseo_title', true);
    if (!$t && $plugin === 'rankmath') $t = get_post_meta($post_id, 'rank_math_title', true);
    $d = get_post_meta($post_id, '_seoplatform_seo_desc', true);
    if (!$d && $plugin === 'yoast')    $d = get_post_meta($post_id, '_yoast_wpseo_metadesc', true);
    if (!$d && $plugin === 'rankmath') $d = get_post_meta($post_id, 'rank_math_description', true);
    return [$t, $d];
}
function seop_ai_autofix($meta_cap = 10, $alt_cap = 8) {
    if (!get_option(SEOP_OPT_AI_KEY)) return new WP_Error('seop_ai', 'Add an Anthropic API key on the SEO Platform settings page first.');
    $report = ['ok' => true, 'ran_at' => current_time('mysql'), 'metas' => [], 'alts' => [], 'skipped' => []];
    $site = get_bloginfo('name');
    $posts = get_posts(['post_type' => ['post', 'page'], 'post_status' => 'publish', 'numberposts' => 200, 'orderby' => 'modified', 'order' => 'DESC']);

    // 1) Missing SEO titles / meta descriptions (fill only what's absent).
    $done = 0;
    foreach ($posts as $p) {
        if ($done >= $meta_cap) break;
        list($t, $d) = seop_existing_meta($p->ID);
        if ($t && $d) continue;
        $excerpt = mb_substr(wp_strip_all_tags($p->post_content), 0, 1200);
        $out = seop_claude(
            'You write SEO meta for web pages. Return ONLY compact JSON, no markdown: {"title":"50-60 char SEO title","description":"150-160 char meta description with a call to action"}.',
            "Site: {$site}. Page title: {$p->post_title}. Page content:\n{$excerpt}", 300
        );
        if (is_wp_error($out)) { $report['skipped'][] = $p->post_title . ' — ' . $out->get_error_message(); continue; }
        $j = json_decode(trim(preg_replace('/```json|```/', '', $out)), true);
        if (!is_array($j)) { $report['skipped'][] = $p->post_title . ' — unparseable AI reply'; continue; }
        seop_write_meta($p->ID, $t ? null : ($j['title'] ?? null), $d ? null : ($j['description'] ?? null), null);
        $report['metas'][] = $p->post_title;
        $done++;
    }

    // 2) Images missing alt text (adds the alt attribute only; content otherwise untouched).
    $done = 0;
    foreach ($posts as $p) {
        if ($done >= $alt_cap) break;
        if (get_post_meta($p->ID, '_seoplatform_alts_done', true)) continue;
        if (!preg_match_all('/<img\b(?![^>]*\balt\s*=\s*["\'][^"\']*\S)[^>]*>/i', $p->post_content, $mm) || !$mm[0]) {
            update_post_meta($p->ID, '_seoplatform_alts_done', 1); continue;
        }
        $tags = array_slice($mm[0], 0, 12);
        $srcs = [];
        foreach ($tags as $tag) { preg_match('/\bsrc\s*=\s*["\']([^"\']+)["\']/i', $tag, $m); $srcs[] = basename($m[1] ?? 'image'); }
        $lines = [];
        foreach ($srcs as $i => $s) $lines[] = ($i + 1) . '. ' . $s;
        $out = seop_claude(
            'You write concise, descriptive image alt text, max 12 words each. No quotes, no "image of". Return a numbered list only, one item per input line, same order.',
            "Site: {$site}. Page: {$p->post_title}. Images (filenames):\n" . implode("\n", $lines), 400
        );
        if (is_wp_error($out)) { $report['skipped'][] = 'alts: ' . $p->post_title . ' — ' . $out->get_error_message(); continue; }
        $alts = [];
        foreach (preg_split('/\r?\n/', $out) as $line) if (preg_match('/^\s*(\d+)[.)]\s*(.+)$/', $line, $m)) $alts[(int) $m[1] - 1] = sanitize_text_field($m[2]);
        $i = 0;
        $content = preg_replace_callback('/<img\b(?![^>]*\balt\s*=\s*["\'][^"\']*\S)([^>]*)>/i', function ($m) use (&$i, $alts) {
            $alt = $alts[$i] ?? ''; $i++;
            return $alt !== '' ? '<img alt="' . esc_attr($alt) . '"' . $m[1] . '>' : $m[0];
        }, $p->post_content);
        if ($content !== null && $content !== $p->post_content) {
            wp_update_post(['ID' => $p->ID, 'post_content' => $content]);
            $report['alts'][] = $p->post_title . ' (' . count($alts) . ' images)';
        }
        update_post_meta($p->ID, '_seoplatform_alts_done', 1);
        $done++;
    }

    update_option(SEOP_OPT_AI_REPORT, $report);
    return $report;
}

/* Settings screen: REST base + API key + the package file importer. */
add_action('admin_menu', function () {
    add_options_page('SEO Platform Connector', 'SEO Platform', 'manage_options', 'seo-platform', 'seop_settings_page');
});
function seop_settings_page() {
    if (!current_user_can('manage_options')) return;
    if (isset($_POST['seop_regen']) && check_admin_referer('seop_regen')) {
        update_option(SEOP_KEY_OPT, wp_generate_password(48, false, false));
        echo '<div class="notice notice-success"><p>New API key generated.</p></div>';
    }
    $report = null;
    if (!empty($_FILES['seop_pkg']) && check_admin_referer('seop_import')) {
        $f = $_FILES['seop_pkg'];
        if (!empty($f['tmp_name']) && $f['size'] > 0 && $f['size'] < 8 * 1024 * 1024) {
            $pkg = json_decode((string) file_get_contents($f['tmp_name']), true);
            $report = $pkg ? seop_apply_package($pkg) : new WP_Error('seop_json', 'file is not valid JSON');
        } else {
            $report = new WP_Error('seop_file', 'upload failed or file too large (8 MB max)');
        }
    }
    // v1.2: AI auto-fix settings + run-now
    $aiReport = null;
    if (isset($_POST['seop_ai_save']) && check_admin_referer('seop_ai')) {
        if (!empty($_POST['seop_ai_key'])) update_option(SEOP_OPT_AI_KEY, sanitize_text_field($_POST['seop_ai_key']));
        $cron = !empty($_POST['seop_ai_cron']);
        update_option(SEOP_OPT_AI_CRON, $cron ? 1 : 0);
        wp_clear_scheduled_hook('seop_ai_autofix_event');
        if ($cron) wp_schedule_event(time() + HOUR_IN_SECONDS, 'weekly', 'seop_ai_autofix_event');
        echo '<div class="notice notice-success"><p>AI settings saved.</p></div>';
    }
    if (isset($_POST['seop_ai_run']) && check_admin_referer('seop_ai_go')) {
        $aiReport = seop_ai_autofix();
    }
    $key  = get_option(SEOP_KEY_OPT);
    $base = rest_url(SEOP_NS);
    echo '<div class="wrap"><h1>SEO Platform Connector</h1>';
    echo '<p><strong>SEO-only.</strong> This connector never changes your site\'s appearance, theme, layout, or settings. Unapproved content arrives as drafts; approved content publishes on its schedule.</p>';

    echo '<h2>Import package</h2>';
    echo '<p>Upload the <code>deploy-*.json</code> file exported from the 44i platform (the “⬇ Deploy file” button). It applies SEO meta, schema, social tags, robots.txt, llms.txt, redirects, security headers, and creates/schedules the content — all in one shot.</p>';
    echo '<form method="post" enctype="multipart/form-data">' . wp_nonce_field('seop_import', '_wpnonce', true, false);
    echo '<p><input type="file" name="seop_pkg" accept="application/json,.json" required> ';
    echo '<button class="button button-primary">Import &amp; apply</button></p></form>';

    if ($report) {
        if (is_wp_error($report)) {
            echo '<div class="notice notice-error"><p>' . esc_html($report->get_error_message()) . '</p></div>';
        } else {
            echo '<div class="notice notice-success"><p><strong>Package applied.</strong></p></div>';
            echo '<h3>Applied</h3><ul style="list-style:disc;margin-left:20px">';
            foreach ($report['applied'] as $line) echo '<li>' . esc_html($line) . '</li>';
            echo '</ul>';
            if (!empty($report['skipped'])) {
                echo '<h3>Skipped</h3><ul style="list-style:disc;margin-left:20px">';
                foreach ($report['skipped'] as $line) echo '<li>' . esc_html($line) . '</li>';
                echo '</ul>';
            }
            if (!empty($report['manual'])) {
                echo '<h3>Manual follow-ups (GBP posts, server-level items)</h3><ul style="list-style:disc;margin-left:20px">';
                foreach ($report['manual'] as $line) echo '<li>' . esc_html($line) . '</li>';
                echo '</ul>';
            }
        }
    }

    echo '<h2>AI auto-fix</h2>';
    echo '<p>With an Anthropic API key saved, the connector fills in <strong>missing</strong> SEO titles, meta descriptions, and image alt text across the site — on demand, on a weekly schedule, or triggered by the platform. It never overwrites values that already exist. Use a dedicated key with a spend limit; anyone with admin access to this site can read stored keys.</p>';
    $hasAiKey = (bool) get_option(SEOP_OPT_AI_KEY);
    echo '<form method="post">' . wp_nonce_field('seop_ai', '_wpnonce', true, false);
    echo '<table class="form-table">';
    echo '<tr><th>Anthropic API key</th><td><input type="password" name="seop_ai_key" placeholder="' . ($hasAiKey ? '•••••••• (saved — enter to replace)' : 'sk-ant-…') . '" style="width:340px"> <em>' . ($hasAiKey ? 'configured' : 'not set') . '</em></td></tr>';
    echo '<tr><th>Weekly auto-fix</th><td><label><input type="checkbox" name="seop_ai_cron" value="1"' . (get_option(SEOP_OPT_AI_CRON) ? ' checked' : '') . '> Run automatically every week (keeps new pages covered)</label></td></tr>';
    echo '</table><p><button class="button" name="seop_ai_save" value="1">Save AI settings</button></p></form>';
    if ($hasAiKey) {
        echo '<form method="post">' . wp_nonce_field('seop_ai_go', '_wpnonce', true, false);
        echo '<p><button class="button button-primary" name="seop_ai_run" value="1">Run AI auto-fix now</button> <em>Fills up to 10 pages of missing metas + 8 pages of missing alts per run.</em></p></form>';
    }
    $lastAi = $aiReport && !is_wp_error($aiReport) ? $aiReport : get_option(SEOP_OPT_AI_REPORT);
    if ($aiReport && is_wp_error($aiReport)) {
        echo '<div class="notice notice-error"><p>' . esc_html($aiReport->get_error_message()) . '</p></div>';
    }
    if (is_array($lastAi) && !empty($lastAi['ran_at'])) {
        echo '<p><strong>Last AI run:</strong> ' . esc_html($lastAi['ran_at']) . ' — ' . count($lastAi['metas'] ?? []) . ' pages got metas, ' . count($lastAi['alts'] ?? []) . ' pages got alts' . (!empty($lastAi['skipped']) ? ', ' . count($lastAi['skipped']) . ' skipped' : '') . '.</p>';
        if (!empty($lastAi['skipped'])) {
            echo '<ul style="list-style:disc;margin-left:20px">';
            foreach ($lastAi['skipped'] as $line) echo '<li>' . esc_html($line) . '</li>';
            echo '</ul>';
        }
    }

    echo '<h2>Connection</h2><table class="form-table">';
    echo '<tr><th>REST base URL</th><td><code>' . esc_html($base) . '</code></td></tr>';
    echo '<tr><th>API key</th><td><code>' . esc_html($key) . '</code></td></tr>';
    echo '<tr><th>Active SEO plugin</th><td><code>' . esc_html(seop_seo_plugin()) . '</code></td></tr>';
    echo '<tr><th>Connector version</th><td><code>' . esc_html(SEOP_VERSION) . '</code></td></tr>';
    echo '</table>';
    echo '<form method="post">' . wp_nonce_field('seop_regen', '_wpnonce', true, false);
    echo '<p><button class="button" name="seop_regen" value="1">Regenerate API key</button></p></form>';
    echo '</div>';
}
