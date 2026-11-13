<?php
/**
 * Plugin Name: Your Digital Group SEO Connector
 * Description: Securely receives SEO metadata, JSON-LD schema, and content from your agency's SEO platform — one item at a time via REST, or everything at once via a deploy-package file (Settings → SEO Platform → Import package). SEO-focused — it never changes your theme, layout, menus or visual settings; its only visible additions are optional (footer business address, an About box under platform-written posts) and switchable under Settings → SEO Platform. Unapproved content arrives as drafts; approved content publishes on its schedule.
 * Version: 1.13.0
 * Author: Your Digital Group
 * License: GPL-2.0+
 * Requires at least: 5.0
 * Requires PHP: 7.0
 * Tested up to: 6.7
 */

if (!defined('ABSPATH')) exit;

// If another copy of this plugin loaded first (folder uploaded twice during
// an update), bail instead of fataling on "Cannot redeclare seop_authed()" —
// and deactivate whichever copy is older so the site converges to one.
if (defined('SEOP_VERSION')) {
    add_action('admin_init', function () {
        if (!function_exists('deactivate_plugins') || !current_user_can('activate_plugins')) return;
        $mine = plugin_basename(__FILE__);
        if (version_compare(SEOP_VERSION, '1.13.0', '<')) {
            // the copy that loaded first is older — retire it, keep this one
            foreach ((array) get_option('active_plugins', []) as $p) {
                if ($p !== $mine && basename($p) === basename(__FILE__)) deactivate_plugins($p, true);
            }
        } else {
            deactivate_plugins($mine, true);   // the other copy is same/newer — retire this one
        }
    });
    return;
}

// Some hosting blocks outbound HTTP by default, which breaks the AI auto-fix
// (api.anthropic.com). wp-config.php loads before plugins, so this only takes
// effect when the constant isn't already defined there.
if (!defined('WP_HTTP_BLOCK_EXTERNAL')) define('WP_HTTP_BLOCK_EXTERNAL', false);

define('SEOP_NS', 'seo-platform/v1');
define('SEOP_KEY_OPT', 'seoplatform_api_key');
define('SEOP_VERSION', '1.13.0');
// v1.2: built-in AI auto-fix (fills MISSING SEO titles/descriptions and image
// alts site-wide using the Anthropic API; never overwrites existing values).
define('SEOP_OPT_AI_KEY',    'seoplatform_anthropic_key');
define('SEOP_OPT_AI_WORKSPACE', 'seoplatform_anthropic_workspace');
// v1.10: NO Anthropic key on client sites. The AI auto-fix calls the SEO
// Platform's wp-ai function, which holds the key in Supabase and accepts this
// site's own connector API key (the one pasted into Platform Access). Nothing
// to enter, nothing readable from the plugin, its files or the database.
// A host who wants to bill their own Anthropic account can still define
// SEOP_ANTHROPIC_API_KEY (+ SEOP_ANTHROPIC_WORKSPACE_ID) in wp-config.php.
if (!defined('SEOP_PLATFORM_AI_URL')) define('SEOP_PLATFORM_AI_URL', 'https://qjmwsxwoefixuuqvkqmz.supabase.co/functions/v1/wp-ai');
// v1.12: the platform hears about content going live (scheduled posts
// publishing) so it can notify the account manager on the client's Trello card.
if (!defined('SEOP_PLATFORM_EVENTS_URL')) define('SEOP_PLATFORM_EVENTS_URL', 'https://qjmwsxwoefixuuqvkqmz.supabase.co/functions/v1/wp-events');
function seop_ai_key() {
    return (defined('SEOP_ANTHROPIC_API_KEY') && SEOP_ANTHROPIC_API_KEY) ? (string) SEOP_ANTHROPIC_API_KEY : '';
}
function seop_ai_workspace() {
    return (defined('SEOP_ANTHROPIC_WORKSPACE_ID') && SEOP_ANTHROPIC_WORKSPACE_ID) ? (string) SEOP_ANTHROPIC_WORKSPACE_ID : '';
}
/* AI is available when the host set its own key, or (normally) when this site
 * has its connector API key — the platform does the rest. */
function seop_ai_ready() {
    return seop_ai_key() !== '' || (string) get_option(SEOP_KEY_OPT) !== '';
}
// Keys typed into older versions are wiped on update — they must not linger
// in wp_options where any admin, backup or plugin can read them.
add_action('init', function () {
    if (get_option(SEOP_OPT_AI_KEY, null) !== null) delete_option(SEOP_OPT_AI_KEY);
    if (get_option(SEOP_OPT_AI_WORKSPACE, null) !== null) delete_option(SEOP_OPT_AI_WORKSPACE);
}, 1);
define('SEOP_OPT_AI_CRON',   'seoplatform_ai_cron');
define('SEOP_OPT_AI_REPORT', 'seoplatform_ai_last_report');
define('SEOP_AI_MODEL', 'claude-haiku-4-5');
// Site-wide artifacts from a deploy package live in options:
define('SEOP_OPT_ROBOTS',    'seoplatform_robots_txt');
define('SEOP_OPT_LLMS',      'seoplatform_llms_txt');
define('SEOP_OPT_LLMS_FULL', 'seoplatform_llms_full_txt');   // v1.13
define('SEOP_OPT_REDIRECTS', 'seoplatform_redirects');      // [{from,to,code}]
define('SEOP_OPT_HEADERS',   'seoplatform_sec_headers');    // {Header-Name: value}
define('SEOP_OPT_SITE_SCHEMA','seoplatform_site_schema');   // JSON-LD strings for the front page
define('SEOP_OPT_LAST_IMPORT','seoplatform_last_import');   // report of the last package import
// v1.3: approved business facts from the deploy package (NAP, hours, socials,
// service area) — powers the site-wide LocalBusiness/E-E-A-T schema engine.
define('SEOP_OPT_BUSINESS',  'seoplatform_business');

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

/* Weekly self-healing: cron re-runs the auto-fix so NEW pages get metas too.
 * WordPress only ships a built-in 'weekly' interval since 5.4, so we register
 * our own — works on every version. */
add_filter('cron_schedules', function ($s) {
    if (!isset($s['seop_weekly'])) $s['seop_weekly'] = ['interval' => WEEK_IN_SECONDS, 'display' => 'Once Weekly (SEO Connector)'];
    return $s;
});
add_action('seop_ai_autofix_event', 'seop_ai_autofix');
/* Self-heal: if the weekly toggle is on but no event is queued (e.g. the old
 * 'weekly' interval silently failed on WP < 5.4, or cron was cleared),
 * re-arm it. */
add_action('init', function () {
    // AI comes from the platform, so it's hands-off: default the weekly pass
    // ON for sites where the toggle has never been saved (an explicit uncheck
    // stores 0 and is respected).
    if (seop_ai_ready() && get_option(SEOP_OPT_AI_CRON, null) === null) {
        update_option(SEOP_OPT_AI_CRON, 1);
    }
    if (get_option(SEOP_OPT_AI_CRON) && !wp_next_scheduled('seop_ai_autofix_event')) {
        wp_schedule_event(time() + HOUR_IN_SECONDS, 'seop_weekly', 'seop_ai_autofix_event');
    }
});
register_deactivation_hook(__FILE__, function () { wp_clear_scheduled_hook('seop_ai_autofix_event'); });

function seop_status() {
    return [
        'ok' => true,
        'connector_version' => SEOP_VERSION,
        'wp_version' => get_bloginfo('version'),
        'seo_plugin' => seop_seo_plugin(),
        'business_loaded' => (bool) (seop_business()['name'] ?? ''),
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
    // The theme renders the post title as the page's H1. An H1 inside the body
    // makes two, which fails the audit's single-H1 check on every imported
    // page — demote body H1s to H2 so imports can't regress the on-page score.
    $content = preg_replace('/<(\/?)h1\b/i', '<$1h2', $content);
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
    $kept_live = false;
    if ($existing) {
        // Never demote content a human already published or scheduled: a
        // re-import whose console copy is still unapproved must not un-publish
        // a live page, and a published page must not be re-queued as future.
        $cur = get_post_status($existing);
        // v1.9.2: an unapproved (draft) copy arriving for a page that is
        // already live or scheduled must not replace the copy readers see —
        // status was protected before, but title/body/slug were still
        // overwritten, putting unreviewed text live. Keep the page as it is;
        // only the SEO fields below are refreshed.
        if (($cur === 'publish' && $status !== 'publish') || ($cur === 'future' && $status === 'draft')) {
            $id = $existing;
            $kept_live = true;
        } else {
            $data['post_status'] = $status;
            $data['ID'] = $existing; $id = wp_update_post(wp_slash($data), true);
        }
    }
    else           { $id = wp_insert_post(wp_slash($data), true); }
    if (is_wp_error($id)) return $id;
    if ($external) update_post_meta($id, '_seoplatform_external_id', $external);
    if (!empty($p['focus_keyword'])) update_post_meta($id, '_seoplatform_focus_keyword', sanitize_text_field($p['focus_keyword']));
    // v1.8: featured image picked in the platform (Pexels). Sideloaded once —
    // a re-import never re-downloads or replaces an existing thumbnail.
    if (!empty($p['image_url']) && !has_post_thumbnail($id) && filter_var($p['image_url'], FILTER_VALIDATE_URL)) {
        require_once ABSPATH . 'wp-admin/includes/media.php';
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/image.php';
        $att = media_sideload_image(esc_url_raw($p['image_url']), $id, sanitize_text_field($p['image_alt'] ?? $title), 'id');
        if (!is_wp_error($att)) {
            set_post_thumbnail($id, $att);
            if (!empty($p['image_alt'])) update_post_meta($att, '_wp_attachment_image_alt', sanitize_text_field($p['image_alt']));
        }
    }
    if (!empty($p['seo_title']) || !empty($p['seo_description'])) {
        seop_write_meta($id, $p['seo_title'] ?? null, $p['seo_description'] ?? null, null);
    }
    // v1.13: the piece's own JSON-LD from the platform (Article/BlogPosting,
    // Service, HowTo, FAQPage built from the visible copy) — printed in its
    // <head>; the site-wide engine skips any type already present.
    if (!empty($p['schema']) && is_array($p['schema'])) {
        $list = get_post_meta($id, '_seoplatform_schema_list', true);
        $list = is_array($list) ? $list : [];
        foreach (array_slice($p['schema'], 0, 6) as $node) {
            $j = seop_jsonld_safe($node);
            if ($j !== '') $list[md5($j)] = wp_slash($j);
        }
        update_post_meta($id, '_seoplatform_schema_list', $list);
    }
    return ['ok' => true, 'post_id' => $id, 'status' => $kept_live ? get_post_status($id) : $status,
        'kept_live_copy' => $kept_live,
        'scheduled_for' => get_post_status($id) === 'future' ? get_post_time('Y-m-d H:i', false, $id) : null,
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

/* v1.9.2: JSON-LD is decoded and re-encoded with <, >, & escaped as \u003C
 * etc., so no stored value can close the <script> tag and inject markup
 * ("</script><script>…"). Returns '' for anything that isn't valid JSON. */
function seop_jsonld_safe($blob) {
    if (is_array($blob) || is_object($blob)) $data = $blob;
    else {
        $blob = trim((string) $blob);
        // tolerate a pasted <script type="application/ld+json"> wrapper
        $blob = preg_replace('#^<script[^>]*>|</script>\s*$#i', '', $blob);
        $data = json_decode($blob, true);
    }
    if ($data === null || $data === '' || is_scalar($data)) return '';
    $out = wp_json_encode($data, JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    return is_string($out) ? $out : '';
}

/* Store JSON-LD for a page (or site-wide when the target is the front page). */
function seop_store_schema($target, $jsonld) {
    $jsonld = seop_jsonld_safe($jsonld);
    if ($jsonld === '') {
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
    // v1.9.2: no raw fallback — invalid JSON is refused, never stored as markup.
    return seop_store_schema($p['target'] ?? '', $p['jsonld'] ?? null);
}

/* ── Head output: schema (legacy single + list + site-wide) and OG tags ── */
add_action('wp_head', function () {
    if (is_front_page()) {
        foreach ((array) get_option(SEOP_OPT_SITE_SCHEMA, []) as $blob) {
            $safe = seop_jsonld_safe($blob);
            if ($safe !== '') echo "\n<script type=\"application/ld+json\">" . $safe . "</script>\n";
        }
    }
    if (!is_singular()) return;
    $pid = get_queried_object_id();
    // Re-encoded on output too, so blobs stored by older versions are safe.
    $legacy = seop_jsonld_safe(get_post_meta($pid, '_seoplatform_schema', true));
    if ($legacy !== '') echo "\n<script type=\"application/ld+json\">" . $legacy . "</script>\n";
    foreach ((array) get_post_meta($pid, '_seoplatform_schema_list', true) as $blob) {
        $safe = seop_jsonld_safe($blob);
        if ($safe !== '') echo "\n<script type=\"application/ld+json\">" . $safe . "</script>\n";
    }
    $og = get_post_meta($pid, '_seoplatform_og_tags', true);
    if ($og && strpos($og, '[IMAGE_URL]') !== false) {
        // v1.13: OG blocks written with an image placeholder get the real one
        // (featured image, else the branded share image) — or lose that tag.
        $img = has_post_thumbnail($pid) ? (string) get_the_post_thumbnail_url($pid, 'full') : (function_exists('seop_og_image_url') ? seop_og_image_url($pid) : '');
        $og = $img ? str_replace('[IMAGE_URL]', esc_url($img), $og) : preg_replace('#<meta[^>]+\[IMAGE_URL\][^>]*>\s*#', '', $og);
    }
    if ($og) echo "\n" . $og . "\n"; // sanitized to <meta> tags only at import time
}, 20);

/* ── v1.3: site-wide schema engine ────────────────────────────────────────────
 * Correct JSON-LD on EVERY page, built from real data only: the approved
 * business facts delivered by the deploy package, the page's own SEO meta,
 * and WordPress itself (authors, dates, page hierarchy). Covers the audit's
 * schema pillar (WebSite, LocalBusiness/Organization, WebPage, BreadcrumbList,
 * BlogPosting), E-E-A-T (author Person, publisher, dates, contact point) and
 * local (NAP address, geo region meta, service area, GBP/social sameAs).
 * Nothing is ever invented — fields the package didn't deliver are omitted.
 * Types already present (imported platform schema for the page, or printed by
 * Yoast/Rank Math) are skipped, never duplicated. */
function seop_business() { $b = get_option(SEOP_OPT_BUSINESS); return is_array($b) ? $b : []; }

/* v1.4: llms.txt fallback — assembled from real site data only (business facts
 * + published pages), so AI crawlers get a map even before a package ships one. */
function seop_llms_fallback() {
    $cached = get_transient('seop_llms_fallback');
    if ($cached !== false) return $cached;
    $b = seop_business();
    $name = ($b['name'] ?? '') ?: get_bloginfo('name');
    if (!$name) return '';
    $out = "# {$name}\n";
    $desc = ($b['description'] ?? '') ?: get_bloginfo('description');
    if ($desc) $out .= "\n> {$desc}\n";
    if (!empty($b['services'])) $out .= "\nServices: " . implode(', ', (array) $b['services']) . "\n";
    $sa = (array) ($b['service_area'] ?? []);
    $towns = array_filter(array_merge([$sa['primary'] ?? ''], (array) ($sa['secondary'] ?? [])));
    if ($towns) $out .= "Service area: " . implode(', ', $towns) . "\n";
    if ($b['phone'] ?? '') $out .= "Contact: " . $b['phone'] . (($b['email'] ?? '') ? ' · ' . $b['email'] : '') . "\n";
    $out .= "\n## Key pages\n";
    foreach (get_posts(['post_type' => 'page', 'post_status' => 'publish', 'numberposts' => 20, 'orderby' => 'menu_order', 'order' => 'ASC']) as $pg) {
        $out .= "- [" . $pg->post_title . "](" . get_permalink($pg) . ")\n";
    }
    $posts = get_posts(['post_type' => 'post', 'post_status' => 'publish', 'numberposts' => 10]);
    if ($posts) {
        $out .= "\n## Recent articles\n";
        foreach ($posts as $pg) $out .= "- [" . $pg->post_title . "](" . get_permalink($pg) . ")\n";
    }
    set_transient('seop_llms_fallback', $out, DAY_IN_SECONDS);
    return $out;
}

/* v1.13: llms-full.txt — the whole site's readable text as one Markdown file
 * for AI tools (the llms.txt companion). The package's copy wins; otherwise it
 * is built from published pages + recent posts, cached for 12 hours and
 * rebuilt when content changes. */
function seop_html_to_md($html) {
    $html = preg_replace('#<(script|style|noscript|svg|template|form|iframe|nav)\b[\s\S]*?</\1>#i', ' ', (string) $html);
    $html = preg_replace_callback('#<h([1-6])[^>]*>([\s\S]*?)</h\1>#i', function ($m) {
        return "\n\n" . str_repeat('#', max(3, min(6, (int) $m[1] + 1))) . ' ' . seop_clean_text($m[2]) . "\n\n"; }, $html);
    $html = preg_replace_callback('#<li[^>]*>([\s\S]*?)</li>#i', function ($m) { return "\n- " . seop_clean_text($m[1]); }, $html);
    $html = preg_replace('#<(p|div|section|article|br|tr|table|ul|ol)\b[^>]*>#i', "\n", $html);
    $txt = html_entity_decode(wp_strip_all_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $lines = array_map(function ($l) { return trim(preg_replace('/[ \t]+/u', ' ', $l)); }, explode("\n", $txt));
    return trim(preg_replace("/\n{3,}/", "\n\n", implode("\n", $lines)));
}
function seop_llms_full() {
    $pkg = (string) get_option(SEOP_OPT_LLMS_FULL);
    if ($pkg !== '') return $pkg;
    $cached = get_transient('seop_llms_full');
    if ($cached !== false) return $cached;
    $head = (string) get_option(SEOP_OPT_LLMS);
    if ($head === '') $head = seop_llms_fallback();
    $head = trim(preg_replace('/\n## Optional[\s\S]*$/', '', $head));
    $parts = [];
    $items = array_merge(
        get_posts(['post_type' => 'page', 'post_status' => 'publish', 'numberposts' => 30, 'orderby' => 'menu_order', 'order' => 'ASC']),
        get_posts(['post_type' => 'post', 'post_status' => 'publish', 'numberposts' => 15]));
    foreach ($items as $p) {
        $md = seop_html_to_md(seop_rendered_html($p->ID));
        if (str_word_count($md) < 40) continue;
        $parts[] = '## ' . get_the_title($p) . "\n\nURL: " . get_permalink($p) . "\n\n" . mb_substr($md, 0, 12000);
    }
    $out = $head . "\n\n---\n\n" . implode("\n\n---\n\n", $parts) . "\n";
    set_transient('seop_llms_full', $out, 12 * HOUR_IN_SECONDS);
    return $out;
}
add_action('save_post', function () { delete_transient('seop_llms_full'); delete_transient('seop_llms_fallback'); });

/* v1.11: the page body as visitors see it. Page builders (Elementor) keep
 * their content outside post_content, so schema built from post_content alone
 * missed their FAQs entirely. */
function seop_rendered_html($pid) {
    static $cache = [];
    if (isset($cache[$pid])) return $cache[$pid];
    $html = '';
    if (class_exists('\\Elementor\\Plugin') && get_post_meta($pid, '_elementor_edit_mode', true) === 'builder') {
        try { $html = (string) \Elementor\Plugin::$instance->frontend->get_builder_content_for_display($pid, false); }
        catch (\Throwable $e) { $html = ''; }
    }
    if ($html === '') {
        $p = get_post($pid);
        $html = $p ? (function_exists('do_blocks') ? do_blocks($p->post_content) : $p->post_content) : '';
    }
    return $cache[$pid] = $html;
}

function seop_norm($s) {
    $s = html_entity_decode(wp_strip_all_tags((string) $s), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return trim(preg_replace('/[^a-z0-9]+/', ' ', strtolower($s)));
}
function seop_clean_text($s) {
    return trim(preg_replace('/\s+/u', ' ', html_entity_decode(wp_strip_all_tags((string) $s), ENT_QUOTES | ENT_HTML5, 'UTF-8')));
}

/* v1.11: question/answer pairs visible on a page: H2/H3 questions with the
 * copy under them, <details><summary>, and Elementor accordion/toggle tabs.
 * Answers are kept whole (40–1500 characters) — too long means skipped, never
 * truncated, so the FAQPage text always matches the page. */
function seop_faq_from_html($html) {
    $out = []; $seen = [];
    $add = function ($q, $a) use (&$out, &$seen) {
        $q = seop_clean_text($q); $a = seop_clean_text($a);
        if ($q === '' || substr($q, -1) !== '?' || mb_strlen($a) < 40 || mb_strlen($a) > 1500) return;
        $k = seop_norm($q); if (isset($seen[$k])) return;
        $seen[$k] = true; $out[] = ['q' => $q, 'a' => $a];
    };
    if (preg_match_all('/<h([23])[^>]*>(.*?)<\/h\1>(.*?)(?=<h[1-6][^>]*>|<\/section>|$)/is', $html, $m, PREG_SET_ORDER)) {
        foreach ($m as $x) $add($x[2], $x[3]);
    }
    if (preg_match_all('/<details\b[^>]*>\s*<summary\b[^>]*>(.*?)<\/summary>(.*?)<\/details>/is', $html, $m, PREG_SET_ORDER)) {
        foreach ($m as $x) $add($x[1], $x[2]);
    }
    if (preg_match_all('/class="[^"]*elementor-tab-title[^"]*"[^>]*>(.*?)<\/(?:div|a|h[1-6])>.*?class="[^"]*elementor-tab-content[^"]*"[^>]*>(.*?)<\/div>/is', $html, $m, PREG_SET_ORDER)) {
        foreach ($m as $x) $add($x[1], $x[2]);
    }
    return array_slice($out, 0, 12);
}

/* v1.11: steps of a "How to …" guide — its first numbered list (2–20 items). */
function seop_howto_steps($title, $html) {
    if (!preg_match('/^\s*how\s+to\b/i', (string) $title)) return [];
    if (!preg_match('/<ol\b[^>]*>(.*?)<\/ol>/is', $html, $ol)) return [];
    if (!preg_match_all('/<li\b[^>]*>(.*?)<\/li>/is', $ol[1], $li)) return [];
    $steps = array_values(array_filter(array_map('seop_clean_text', $li[1]), function ($t) { return mb_strlen($t) >= 3; }));
    return count($steps) >= 2 && count($steps) <= 20 ? $steps : [];
}

/* v1.11: FAQ questions/answers in the platform's stored JSON-LD for a page. */
function seop_stored_faq($pid) {
    $blobs = [];
    if ($pid) {
        $blobs[] = get_post_meta($pid, '_seoplatform_schema', true);
        foreach ((array) get_post_meta($pid, '_seoplatform_schema_list', true) as $b) $blobs[] = $b;
    }
    if (is_front_page()) foreach ((array) get_option(SEOP_OPT_SITE_SCHEMA, []) as $b) $blobs[] = $b;
    $out = [];
    $walk = function ($o) use (&$walk, &$out) {
        if (!is_array($o)) return;
        $t = (array) ($o['@type'] ?? []);
        if (in_array('FAQPage', $t, true)) {
            foreach ((array) ($o['mainEntity'] ?? []) as $q) {
                $name = trim((string) ($q['name'] ?? '')); $ans = trim((string) ($q['acceptedAnswer']['text'] ?? ''));
                if ($name !== '' && $ans !== '') $out[] = ['q' => $name, 'a' => $ans];
            }
        }
        foreach ($o as $v) if (is_array($v)) $walk($v);
    };
    foreach ($blobs as $b) { if (is_string($b) && $b !== '') $walk(json_decode(wp_unslash($b), true)); }
    return $out;
}

/* v1.11: an FAQ shipped as schema must also be READABLE on the page — AI
 * engines skip FAQPage markup whose questions visitors can't see. Print the
 * questions the page doesn't already show, word-for-word from the schema. */
add_filter('the_content', function ($content) {
    if (!is_singular() || !in_the_loop() || !is_main_query()) return $content;
    $qa = seop_stored_faq(get_queried_object_id());
    if (!$qa) return $content;
    $plain = seop_norm($content);
    $missing = array_values(array_filter($qa, function ($x) use ($plain) { return strpos($plain, seop_norm($x['q'])) === false; }));
    if (!$missing) return $content;
    $h = "\n" . '<section class="seop-faq" style="max-width:800px;margin:2rem auto;line-height:1.6">'
       . '<h2 class="seop-faq-title" style="margin:0 0 1.25rem">Frequently Asked Questions</h2>';
    foreach ($missing as $x) {
        $h .= '<div class="seop-faq-item" style="margin:0 0 1.25rem;padding:0 0 1.25rem;border-bottom:1px solid rgba(0,0,0,.08)">'
            . '<h3 style="margin:0 0 .5rem">' . esc_html($x['q']) . '</h3><p style="margin:0">' . esc_html($x['a']) . '</p></div>';
    }
    return $content . $h . '</section>' . "\n";
}, 97);

/* Schema @types already emitted for this request by other sources. */
function seop_head_types() {
    $types = [];
    $scan = function ($blob) use (&$types) {
        if (is_string($blob) && preg_match_all('/"@type"\s*:\s*"([A-Za-z]+)"/', $blob, $m)) {
            foreach ($m[1] as $t) $types[$t] = true;
        }
    };
    if (is_front_page()) foreach ((array) get_option(SEOP_OPT_SITE_SCHEMA, []) as $blob) $scan($blob);
    if (is_singular()) {
        $pid = get_queried_object_id();
        $scan(get_post_meta($pid, '_seoplatform_schema', true));
        foreach ((array) get_post_meta($pid, '_seoplatform_schema_list', true) as $blob) $scan($blob);
    }
    if (seop_seo_plugin() !== 'none') { $types['WebSite'] = true; $types['BreadcrumbList'] = true; } // Yoast/Rank Math print their own
    return $types;
}

function seop_breadcrumb_node($pid) {
    $items = [['@type' => 'ListItem', 'position' => 1, 'name' => 'Home', 'item' => home_url('/')]];
    $pos = 2;
    $p = get_post($pid);
    if ($p && $p->post_type === 'post') {
        $blog = (int) get_option('page_for_posts');
        if ($blog) $items[] = ['@type' => 'ListItem', 'position' => $pos++, 'name' => get_the_title($blog), 'item' => get_permalink($blog)];
    } elseif ($p) {
        foreach (array_reverse(get_post_ancestors($pid)) as $aid) {
            $items[] = ['@type' => 'ListItem', 'position' => $pos++, 'name' => get_the_title($aid), 'item' => get_permalink($aid)];
        }
    }
    $items[] = ['@type' => 'ListItem', 'position' => $pos, 'name' => get_the_title($pid), 'item' => get_permalink($pid)];
    return ['@type' => 'BreadcrumbList', '@id' => get_permalink($pid) . '#breadcrumb', 'itemListElement' => $items];
}

add_action('wp_head', function () {
    if (is_admin() || is_feed() || is_404() || is_search()) return;
    $b = seop_business(); $have = seop_head_types();
    $home = home_url('/'); $orgId = $home . '#org'; $siteId = $home . '#website';
    $graph = [];

    // WebSite (+ SearchAction) — site identity on every page; helps AEO answers cite the site.
    if (empty($have['WebSite'])) {
        $graph[] = ['@type' => 'WebSite', '@id' => $siteId, 'url' => $home, 'name' => get_bloginfo('name'),
            'publisher' => ['@id' => $orgId], 'inLanguage' => get_bloginfo('language'),
            'potentialAction' => ['@type' => 'SearchAction',
                'target' => ['@type' => 'EntryPoint', 'urlTemplate' => $home . '?s={search_term_string}'],
                'query-input' => 'required name=search_term_string']];
    }

    // LocalBusiness (with delivered facts) or a minimal Organization (without).
    if (empty($have['LocalBusiness']) && empty($have['Organization'])) {
        $hasFacts = ($b['name'] ?? '') !== '';
        $node = ['@type' => $hasFacts ? 'LocalBusiness' : 'Organization', '@id' => $orgId,
            'name' => $hasFacts ? $b['name'] : get_bloginfo('name'), 'url' => $home];
        $logoId = (int) get_theme_mod('custom_logo');
        $logo = $logoId ? wp_get_attachment_url($logoId) : get_site_icon_url();
        if ($logo) { $node['logo'] = $logo; $node['image'] = $logo; }
        if ($hasFacts) {
            if ($b['description'] ?? '') $node['description'] = $b['description'];
            if ($b['phone'] ?? '') {
                $node['telephone'] = $b['phone'];
                $node['contactPoint'] = ['@type' => 'ContactPoint', 'telephone' => $b['phone'], 'contactType' => 'customer service'];
            }
            if ($b['email'] ?? '') $node['email'] = $b['email'];
            if (($b['street'] ?? '') || ($b['city'] ?? '')) {
                $addr = ['@type' => 'PostalAddress', 'addressCountry' => 'US'];
                if ($b['street'] ?? '') $addr['streetAddress'] = $b['street'];
                if ($b['city'] ?? '')   $addr['addressLocality'] = $b['city'];
                if ($b['state'] ?? '')  $addr['addressRegion'] = $b['state'];
                if ($b['zip'] ?? '')    $addr['postalCode'] = $b['zip'];
                $node['address'] = $addr;
            }
            if ($b['hours'] ?? '') {
                $node['openingHours'] = array_values(array_filter(array_map('trim', preg_split('/[;,]/', $b['hours']))));
            }
            $same = array_values(array_filter((array) ($b['sameas'] ?? [])));
            if ($b['gbp_url'] ?? '') { $node['hasMap'] = $b['gbp_url']; $same[] = $b['gbp_url']; }
            if ($same) $node['sameAs'] = $same;
            $area = [];
            $sa = (array) ($b['service_area'] ?? []);
            if ($sa['primary'] ?? '') $area[] = ['@type' => 'City', 'name' => $sa['primary']];
            foreach ((array) ($sa['secondary'] ?? []) as $town) if ($town) $area[] = ['@type' => 'City', 'name' => $town];
            if ($area) $node['areaServed'] = $area;
            // Only from REAL rating data delivered by the platform (e.g. GBP) —
            // an invented AggregateRating is an FTC problem, so absent = omitted.
            if (($b['rating_value'] ?? '') && ($b['rating_count'] ?? '')) {
                $node['aggregateRating'] = ['@type' => 'AggregateRating',
                    'ratingValue' => $b['rating_value'], 'reviewCount' => $b['rating_count']];
            }
        }
        $graph[] = $node;
    }
    // v1.5: a real named person on EVERY page — the audit's E-E-A-T pillar
    // reads Person schema off the home/about pages, where BlogPosting authors
    // never appear. Only from the approved intake's owner field, never invented.
    if (($b['owner'] ?? '') !== '' && empty($have['Person'])) {
        $person = ['@type' => 'Person', '@id' => $home . '#owner', 'name' => $b['owner'],
            'jobTitle' => 'Owner', 'worksFor' => ['@id' => $orgId]];
        $same = array_values(array_filter((array) ($b['sameas'] ?? [])));
        if ($same) $person['sameAs'] = $same;
        $graph[] = $person;
    }

    if (is_singular()) {
        $pid = get_queried_object_id(); $p = get_post($pid); $url = get_permalink($pid);
        list($t, $d) = seop_existing_meta($pid);
        if (empty($have['WebPage']) && empty($have['AboutPage']) && empty($have['ContactPage']) && empty($have['FAQPage'])) {
            $graph[] = ['@type' => 'WebPage', '@id' => $url . '#webpage', 'url' => $url,
                'name' => $t ?: get_the_title($pid),
                'description' => $d ?: wp_strip_all_tags(get_the_excerpt($pid)),
                'isPartOf' => ['@id' => $siteId], 'about' => ['@id' => $orgId],
                'datePublished' => get_the_date('c', $pid), 'dateModified' => get_the_modified_date('c', $pid),
                'inLanguage' => get_bloginfo('language')];
        }
        if (empty($have['BreadcrumbList']) && !is_front_page()) $graph[] = seop_breadcrumb_node($pid);
        // v1.4 / v1.11: FAQPage from the page's OWN Q&A — question headings,
        // <details>/<summary> and Elementor accordions/toggles — read from the
        // RENDERED page (Elementor keeps content outside post_content). Answers
        // are copied whole, never cut short, so the schema mirrors the page.
        if (empty($have['FAQPage']) && $p) {
            $faq = [];
            foreach (seop_faq_from_html(seop_rendered_html($pid)) as $x) {
                $faq[] = ['@type' => 'Question', 'name' => $x['q'], 'acceptedAnswer' => ['@type' => 'Answer', 'text' => $x['a']]];
            }
            if (count($faq) >= 2) $graph[] = ['@type' => 'FAQPage', '@id' => $url . '#faq', 'mainEntity' => $faq];
        }
        // v1.11: HowTo for "How to …" guides — one HowToStep per item of the
        // page's numbered list, text copied verbatim.
        if (empty($have['HowTo']) && $p) {
            $steps = seop_howto_steps(get_the_title($pid), seop_rendered_html($pid));
            if ($steps) {
                $node = ['@type' => 'HowTo', '@id' => $url . '#howto', 'name' => get_the_title($pid), 'step' => []];
                foreach ($steps as $i => $st) $node['step'][] = ['@type' => 'HowToStep', 'position' => $i + 1, 'text' => $st, 'url' => $url . '#step-' . ($i + 1)];
                $img = get_the_post_thumbnail_url($pid, 'full'); if ($img) $node['image'] = $img;
                $graph[] = $node;
            }
        }
        // Posts: BlogPosting with a real author Person — the E-E-A-T backbone.
        if ($p && $p->post_type === 'post' && empty($have['BlogPosting']) && empty($have['Article'])) {
            $aid = (int) $p->post_author;
            $node = ['@type' => 'BlogPosting', '@id' => $url . '#article',
                'headline' => mb_substr(get_the_title($pid), 0, 110),
                'author' => ['@type' => 'Person',
                    'name' => get_the_author_meta('display_name', $aid) ?: get_bloginfo('name'),
                    'url' => get_author_posts_url($aid),
                    'worksFor' => ['@id' => $orgId]],
                'publisher' => ['@id' => $orgId],
                'datePublished' => get_the_date('c', $pid), 'dateModified' => get_the_modified_date('c', $pid),
                'mainEntityOfPage' => $url, 'inLanguage' => get_bloginfo('language')];
            $img = get_the_post_thumbnail_url($pid, 'full'); if ($img) $node['image'] = $img;
            $kw = get_post_meta($pid, '_seoplatform_focus_keyword', true); if ($kw) $node['keywords'] = $kw;
            $graph[] = $node;
        }
    }

    if ($graph) {
        echo "\n<script type=\"application/ld+json\">"
            . wp_json_encode(['@context' => 'https://schema.org', '@graph' => $graph], JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP)
            . "</script>\n";
    }
    // Local geo hints on every page — harmless meta that reinforces the service area.
    if (($b['city'] ?? '') !== '') {
        echo '<meta name="geo.placename" content="' . esc_attr($b['city']) . '">' . "\n";
        if (($b['state'] ?? '') !== '') echo '<meta name="geo.region" content="US-' . esc_attr(strtoupper(substr(trim($b['state']), 0, 2))) . '">' . "\n";
    }
}, 21);

/* v1.5.3: drafts imported before the fence-stripping fix left artifacts like
 * a paragraph of just “` in page content. Scrub at render time: remove
 * paragraphs whose visible text is only quotes/backticks. Skips pages that
 * legitimately use code blocks; touches nothing else. */
add_filter('the_content', function ($c) {
    if (strpos($c, '`') === false) return $c;
    if (strpos($c, '<code') !== false || strpos($c, '<pre') !== false) return $c;
    return preg_replace_callback('/<p\b[^>]*>([\s\S]*?)<\/p>\s*/i', function ($m) {
        $txt = trim(html_entity_decode(wp_strip_all_tags($m[1]), ENT_QUOTES | ENT_HTML5));
        $junk = $txt !== '' && strpos($txt, '`') !== false
            && preg_match('/^[\s`"\'\x{201C}\x{201D}\x{2018}\x{2019}\x{2026}.,;:—–-]+$/u', $txt);
        return $junk ? '' : $m[0];
    }, $c);
}, 98);

/* v1.5.2: the trust/credentials sentence, shared by the About-page appender
 * and the render-time filter. Real credentials when delivered; otherwise a
 * general sentence true for any operating business. Never invents specifics. */
function seop_trust_sentence() {
    $b = seop_business();
    if (($b['name'] ?? '') === '') return '';
    $city = trim((string) (($b['service_area']['primary'] ?? '') ?: ($b['city'] ?? '')));
    $what = !empty($b['services']) ? implode(', ', array_slice((array) $b['services'], 0, 3)) : (($b['type'] ?? '') ?: 'their field');
    $creds = trim((string) ($b['credentials'] ?? ''));
    return $creds !== ''
        ? rtrim($creds, '.') . ' — backed by years of experience serving ' . ($city ?: 'the area') . '.'
        : 'The ' . $b['name'] . ' team brings years of experience in ' . $what . ' to every project' . ($city ? ', serving ' . $city . ' and the surrounding communities' : '') . '.';
}

/* v1.5.2: page builders (Elementor, Divi, …) render from their OWN data and
 * ignore post_content — so text appended there never reaches the page. This
 * filter appends the trust sentence to the RENDERED about page when the
 * rendered output still lacks the language. Idempotent by construction. */
add_filter('the_content', function ($content) {
    if (!is_page() || !in_the_loop() || !is_main_query()) return $content;
    $slug = get_post_field('post_name', get_queried_object_id());
    if (!in_array($slug, ['about', 'about-us', 'our-team', 'our-story', 'team', 'meet-the-team'], true)) return $content;
    if (preg_match('/certified|licensed|award|years of experience|accredited|board[- ]certified/', strtolower(wp_strip_all_tags($content)))) return $content;
    $s = seop_trust_sentence();
    return $s === '' ? $content : $content . "\n<p>" . esc_html($s) . '</p>';
}, 99);

/* v1.5: the audit's privacy check needs the privacy page LINKED on the page,
 * not just existing. If no nav menu links it, print one discreet footer link.
 * (The one deliberate, minimal visual addition this plugin makes.) */
add_action('wp_footer', function () {
    $pid = (int) get_option('wp_page_for_privacy_policy');
    if (!$pid || get_post_status($pid) !== 'publish') return;
    foreach (wp_get_nav_menus() as $menu) {
        foreach (wp_get_nav_menu_items($menu) ?: [] as $item) {
            if ((int) $item->object_id === $pid) return; // theme already links it
        }
    }
    echo '<p style="text-align:center;font-size:12px;opacity:.75;margin:14px 0"><a href="'
        . esc_url(get_permalink($pid)) . '">Privacy Policy</a></p>' . "\n";
});

/* ── Site-wide appliers from the deploy package ── */
// robots.txt (only when WP serves it, i.e. no physical file exists)
add_filter('robots_txt', function ($output) {
    $custom = get_option(SEOP_OPT_ROBOTS);
    return $custom ? $custom : $output;
}, 20);

// /llms.txt + 301 redirects
add_action('template_redirect', function () {
    $uri = isset($_SERVER['REQUEST_URI']) ? wp_parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) : '';
    if ($uri === '/llms-full.txt') {
        $body = seop_llms_full();
        if ($body) { status_header(200); header('Content-Type: text/plain; charset=utf-8'); header('X-Robots-Tag: noindex'); echo $body; exit; }
    }
    if ($uri === '/llms.txt') {
        $body = get_option(SEOP_OPT_LLMS);
        if (!$body) $body = seop_llms_fallback(); // v1.4: auto-generate from real site data
        // v1.5.4: WP has already flagged this unknown URL as a 404 by now — the
        // body was being served with a 404 status, which crawlers (and the
        // audit) rightly treat as "no llms.txt". Assert 200 explicitly.
        if ($body) { status_header(200); header('Content-Type: text/plain; charset=utf-8'); echo $body; exit; }
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
// v1.4: the four safe headers are on BY DEFAULT — the audit fails sites without
// them and they carry no rendering risk (unlike CSP, which stays manual-only).
// Package-imported values override the defaults per header.
// v1.9.2: only these may be set from a package — anything else (Set-Cookie,
// Location, Refresh, Access-Control-*, Content-Type) could hijack the site.
function seop_header_allowed($name) {
    return in_array(strtolower((string) $name), ['strict-transport-security', 'x-content-type-options', 'x-frame-options',
        'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy', 'x-xss-protection'], true);
}
function seop_default_headers() {
    $h = ['X-Content-Type-Options' => 'nosniff',
          'X-Frame-Options' => 'SAMEORIGIN',
          'Referrer-Policy' => 'strict-origin-when-cross-origin'];
    if (is_ssl()) $h['Strict-Transport-Security'] = 'max-age=31536000';
    return $h;
}
add_action('send_headers', function () {
    $headers = array_merge(seop_default_headers(), (array) get_option(SEOP_OPT_HEADERS, []));
    foreach ($headers as $name => $value) {
        if (preg_match('/^[A-Za-z0-9-]+$/', $name) && seop_header_allowed($name) && is_string($value) && !headers_sent()) {
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
    if (!is_array($pkg) || !in_array($pkg['format'] ?? '', ['ydg-deploy-package', '44i-deploy-package'], true)) {
        return new WP_Error('seop_format', 'not a deploy-package file from the SEO platform', ['status' => 400]);
    }
    $r = ['applied' => [], 'skipped' => [], 'manual' => []];
    $ok = function ($what) use (&$r) { $r['applied'][] = $what; };
    $skip = function ($what, $why) use (&$r) { $r['skipped'][] = $what . ' — ' . $why; };

    // v1.12: the file carries this site's connector API key from the
    // platform — adopt it, so nobody copies the key into the console by hand.
    // Only when the file was built for THIS site (a file for another client
    // must never re-key this one).
    $ck = isset($pkg['connector']['api_key']) ? (string) $pkg['connector']['api_key'] : '';
    if ($ck !== '') {
        if (!preg_match('/^[A-Za-z0-9]{32,128}$/', $ck)) {
            $skip('Connector API key', 'malformed key in the file');
        } elseif (!seop_same_site((string) ($pkg['site'] ?? ''))) {
            $skip('Connector API key', 'this file was built for ' . esc_html((string) ($pkg['site'] ?? 'another site')) . ', not ' . esc_html(home_url('/')));
        } elseif (!hash_equals((string) get_option(SEOP_KEY_OPT), $ck)) {
            update_option(SEOP_KEY_OPT, $ck);
            $ok('Connector API key set from the platform (this site is now connected — no key to copy)');
        }
    }

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
    if (!empty($files['llms_full_txt'])) { update_option(SEOP_OPT_LLMS_FULL, sanitize_textarea_field($files['llms_full_txt']), false); delete_transient('seop_llms_full'); $ok('llms-full.txt (served at /llms-full.txt)'); }
    elseif (!empty($files['llms_txt'])) { delete_option(SEOP_OPT_LLMS_FULL); delete_transient('seop_llms_full'); $ok('llms-full.txt built from the site\'s own pages (served at /llms-full.txt)'); }
    if (!empty($files['sitemap_xml'])) $r['manual'][] = 'Sitemap: prefer your SEO plugin\'s sitemap (Yoast/Rank Math serve one automatically); the package includes a fallback file if you need it.';
    $rules = (array) (($pkg['redirects']['rules'] ?? []) ?: []);
    if ($rules) {
        // v1.9.2: keyed by source path so a corrected rule REPLACES the old one
        // (first-match-wins used to keep the mistake forever); targets must stay
        // on this site; self-redirects and A→B→A loops are refused.
        $pathOf = function ($u) { $p = wp_parse_url((string) $u, PHP_URL_PATH); return strtolower(untrailingslashit($p ?: '/') ?: '/'); };
        $siteHost = strtolower(preg_replace('/^www\./', '', (string) wp_parse_url(home_url(), PHP_URL_HOST)));
        $byFrom = [];
        foreach ((array) get_option(SEOP_OPT_REDIRECTS, []) as $old) if (!empty($old['from'])) $byFrom[$pathOf($old['from'])] = $old;
        $added = 0;
        foreach ($rules as $rule) {
            if (empty($rule['from']) || empty($rule['to'])) continue;
            $from = sanitize_text_field($rule['from']); $to = esc_url_raw($rule['to']);
            if (strpos($to, '//') === 0) { $skip('Redirect ' . $from, 'protocol-relative target'); continue; }
            $toHost = strtolower(preg_replace('/^www\./', '', (string) wp_parse_url($to, PHP_URL_HOST)));
            if ($toHost !== '' && $toHost !== $siteHost) { $skip('Redirect ' . $from, 'target is on another site (' . $toHost . ')'); continue; }
            $f = $pathOf($from); $t = $pathOf($to);
            if ($f === '/' || $f === $t) { $skip('Redirect ' . $from, $f === '/' ? 'the homepage cannot be redirected' : 'redirects to itself'); continue; }
            if (isset($byFrom[$t]) && $pathOf($byFrom[$t]['to']) === $f) { $skip('Redirect ' . $from, 'would loop with the rule for ' . $t); continue; }
            $byFrom[$f] = ['from' => $from, 'to' => $to, 'code' => 301]; $added++;
        }
        update_option(SEOP_OPT_REDIRECTS, array_values($byFrom));
        $ok($added . ' redirect rule(s)');
    }
    if (!empty($pkg['redirects']['raw']) && !$rules) $r['manual'][] = 'Redirects: the package includes server rules (.htaccess/nginx) that need to be applied at the server level.';
    if (!empty($pkg['security_headers']['raw'])) {
        $headers = seop_parse_header_lines($pkg['security_headers']['raw']);
        // A wrong Content-Security-Policy can block the site's own scripts/styles,
        // break rendering, and tank PageSpeed — never auto-apply it; the safe
        // headers (HSTS, X-Content-Type-Options, Referrer-Policy, …) still go on.
        if (isset($headers['Content-Security-Policy'])) {
            unset($headers['Content-Security-Policy']);
            $r['manual'][] = 'Content-Security-Policy: test on staging and apply at the server level — auto-applying a CSP can break page rendering.';
        }
        $blocked = array_diff(array_keys($headers), array_filter(array_keys($headers), 'seop_header_allowed'));
        $headers = array_filter($headers, 'seop_header_allowed', ARRAY_FILTER_USE_KEY);
        if ($blocked) $skip('Headers ' . implode(', ', $blocked), 'not on the security-header allowlist');
        if ($headers) { update_option(SEOP_OPT_HEADERS, $headers); $ok(count($headers) . ' security header(s) (sent by WordPress)'); }
        else $skip('Security headers', 'no parseable header lines');
    }
    // v1.3: approved business facts → powers site-wide LocalBusiness/E-E-A-T schema.
    if (!empty($pkg['business']) && is_array($pkg['business'])) {
        $biz = [];
        foreach ($pkg['business'] as $k => $v) {
            if ($k === 'sameas') { $biz[$k] = array_values(array_filter(array_map('esc_url_raw', array_filter((array) $v, 'is_scalar')))); continue; }
            if (is_array($v)) $v = implode(', ', array_filter($v, 'is_scalar'));
            $biz[$k] = is_scalar($v) ? sanitize_text_field((string) $v) : '';
        }
        update_option(SEOP_OPT_BUSINESS, $biz);
        delete_transient('seop_llms_fallback'); delete_transient('seop_llms_full');
        $ok('Business profile (name, NAP, hours, service area — powers site-wide schema)');
    }
    // v1.13: site-experience switches chosen in the platform.
    if (!empty($pkg['features']) && is_array($pkg['features'])) {
        $cur = get_option(SEOP_OPT_FEATURES); $cur = is_array($cur) ? $cur : [];
        foreach (['delay_scripts', 'gzip', 'webp', 'og_images', 'footer_nap', 'eeat_box'] as $k)
            if (array_key_exists($k, $pkg['features'])) $cur[$k] = !empty($pkg['features'][$k]) ? 1 : 0;
        if (!empty($pkg['features']['brand_color']) && preg_match('/^#[0-9a-f]{6}$/i', (string) $pkg['features']['brand_color'])) $cur['brand_color'] = (string) $pkg['features']['brand_color'];
        update_option(SEOP_OPT_FEATURES, $cur);
        $on = array_keys(array_filter($cur, function ($v, $k) { return $k !== 'brand_color' && $v; }, ARRAY_FILTER_USE_BOTH));
        $ok('Site features: ' . ($on ? implode(', ', $on) : 'all off'));
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
            'image_url' => $cItem['image_url'] ?? '', 'image_alt' => $cItem['image_alt'] ?? '',
            'schema' => (isset($cItem['schema']) && is_array($cItem['schema'])) ? $cItem['schema'] : [],
        ]);
        if (is_wp_error($res)) $skip('Content "' . ($cItem['title'] ?? '?') . '"', $res->get_error_message());
        elseif (($res['status'] ?? '') === 'future') { $scheduled++; $ok('Scheduled "' . ($cItem['title'] ?? '?') . '" → publishes ' . ($res['scheduled_for'] ?: 'per campaign')); }
        elseif (($res['status'] ?? '') === 'publish') { $ok('"' . ($cItem['title'] ?? '?') . '" is already live — updated in place'); }
        else $drafted++;
    }
    if ($scheduled) $ok($scheduled . ' piece(s) scheduled on the campaign calendar (dates above)');
    if ($drafted)   $ok($drafted . ' draft(s) created for review — drafts never auto-publish. (WordPress labels every draft “Publish immediately”; that\'s just the editor default. Approve the piece in the SEO platform and re-import, or hit Publish here.)');
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
    $key = seop_ai_key();
    if (!$key) return seop_claude_via_platform($system, $user, $max);
    $headers = ['x-api-key' => $key, 'anthropic-version' => '2023-06-01', 'content-type' => 'application/json'];
    // Keys not scoped to a single workspace must name the workspace per request.
    if (seop_ai_workspace()) $headers['anthropic-workspace-id'] = seop_ai_workspace();
    $r = wp_remote_post('https://api.anthropic.com/v1/messages', [
        'timeout' => 60,
        'headers' => $headers,
        'body' => wp_json_encode(['model' => SEOP_AI_MODEL, 'max_tokens' => $max, 'system' => $system,
            'messages' => [['role' => 'user', 'content' => $user]]]),
    ]);
    if (is_wp_error($r)) return $r;
    if (wp_remote_retrieve_response_code($r) !== 200) {
        $bodyTxt = (string) wp_remote_retrieve_body($r);
        $msg = 'Anthropic ' . wp_remote_retrieve_response_code($r) . ': ' . substr($bodyTxt, 0, 160);
        if (stripos($bodyTxt, 'workspace') !== false && !seop_ai_workspace()) {
            $msg .= ' — this API key is not scoped to a workspace: also define SEOP_ANTHROPIC_WORKSPACE_ID (wrkspc_…) in wp-config.php, or remove SEOP_ANTHROPIC_API_KEY to use the SEO Platform\'s AI.';
        }
        return new WP_Error('seop_ai', $msg);
    }
    $body = json_decode(wp_remote_retrieve_body($r), true);
    $text = '';
    foreach ((array) ($body['content'] ?? []) as $b) if (($b['type'] ?? '') === 'text') $text .= $b['text'];
    return trim($text);
}
/* v1.10: the normal path — the platform makes the Anthropic call. */
function seop_claude_via_platform($system, $user, $max) {
    $siteKey = (string) get_option(SEOP_KEY_OPT);
    if ($siteKey === '') return new WP_Error('seop_ai', 'This site has no connector API key yet — reload the SEO Platform settings page.');
    $r = wp_remote_post(SEOP_PLATFORM_AI_URL, [
        'timeout' => 70,
        'headers' => ['Authorization' => 'Bearer ' . $siteKey, 'Content-Type' => 'application/json'],
        'body' => wp_json_encode(['system' => $system, 'user' => $user, 'max_tokens' => (int) $max]),
    ]);
    if (is_wp_error($r)) return $r;
    $code = (int) wp_remote_retrieve_response_code($r);
    $body = json_decode((string) wp_remote_retrieve_body($r), true);
    if ($code !== 200 || empty($body['ok'])) {
        $msg = is_array($body) && !empty($body['error']) ? (string) $body['error'] : 'HTTP ' . $code;
        return new WP_Error('seop_ai', 'SEO Platform AI: ' . $msg);
    }
    return trim((string) ($body['text'] ?? ''));
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
/* Deterministic alt from a filename: "kitchen-remodel_sioux-falls-2-300x200.jpg"
 * → "Kitchen remodel sioux falls". Used when the AI reply misses an item. */
function seop_alt_from_filename($file) {
    $s = preg_replace('/\.[a-z0-9]+$/i', '', basename((string) $file));
    $s = preg_replace('/-?\d+x\d+$|-scaled$|-copy(-\d+)?$|-e\d{10,}/i', '', $s);
    $s = trim(preg_replace('/[-_]+/', ' ', $s));
    $s = trim(preg_replace('/\s*\d+\s*$/', '', $s));
    if ($s === '' || preg_match('/^(img|image|dsc|photo|screenshot|untitled)[\s\d]*$/i', $s)) return '';
    return ucfirst(strtolower($s));
}
/* v1.4: link the first plain-text mention of a keyword to its target page.
 * Walks the HTML token-by-token so it never touches existing anchors,
 * headings, shortcodes, or tag attributes. Returns new content or null. */
function seop_link_keyword($content, $kw, $url) {
    if (stripos($content, 'href="' . $url) !== false) return null; // already links there
    $parts = preg_split('/(<[^>]+>|\[[^\]]+\])/', $content, -1, PREG_SPLIT_DELIM_CAPTURE);
    $inA = 0; $inH = 0; $inBtn = 0; $inRaw = 0; $scStack = [];
    $rx = '/\b(' . preg_quote($kw, '/') . ')\b/i';
    foreach ($parts as $i => $seg) {
        if ($seg === '' ) continue;
        if ($seg[0] === '<') {
            if (preg_match('/^<a\b/i', $seg)) $inA++;
            elseif (preg_match('/^<\/a>/i', $seg)) $inA = max(0, $inA - 1);
            elseif (preg_match('/^<h[1-6]\b/i', $seg)) $inH++;
            elseif (preg_match('/^<\/h[1-6]>/i', $seg)) $inH = max(0, $inH - 1);
            elseif (preg_match('/^<button\b/i', $seg)) $inBtn++;
            elseif (preg_match('/^<\/button>/i', $seg)) $inBtn = max(0, $inBtn - 1);
            elseif (preg_match('/^<(script|style|textarea|code|pre)\b/i', $seg)) $inRaw++;
            elseif (preg_match('/^<\/(script|style|textarea|code|pre)>/i', $seg)) $inRaw = max(0, $inRaw - 1);
            continue;
        }
        if ($seg[0] === '[') {
            // Shortcode wrappers ([button]…[/button]) must not gain links inside.
            // Conservative: while ANY shortcode is open, don't link — a
            // self-closing one ([gallery]) just costs missed opportunities.
            if (preg_match('/^\[\/([a-zA-Z0-9_-]+)\]/', $seg, $m)) {
                if (end($scStack) === strtolower($m[1])) array_pop($scStack);
            } elseif (preg_match('/^\[([a-zA-Z0-9_-]+)/', $seg, $m)) {
                $scStack[] = strtolower($m[1]);
            }
            continue;
        }
        if ($inA || $inH || $inBtn || $inRaw || $scStack) continue;
        if (preg_match($rx, $seg)) {
            $parts[$i] = preg_replace($rx, '<a href="' . esc_url($url) . '">$1</a>', $seg, 1);
            return implode('', $parts);
        }
    }
    return null;
}
/* v1.9.2: save a body the plugin itself rewrote (alt text, one link, a
 * trust sentence — all escaped at insertion). wp_update_post expects slashed
 * data (unslashed input lost every backslash, breaking block attributes), and
 * cron/REST runs have no user with unfiltered_html, so the kses filter used to
 * strip the page's own iframes, forms and embeds on save. */
function seop_save_rewritten($post_id, $content) {
    $had_kses = has_filter('content_save_pre', 'wp_filter_post_kses');
    if ($had_kses) kses_remove_filters();
    $r = wp_update_post(wp_slash(['ID' => $post_id, 'post_content' => $content]), true);
    if ($had_kses) kses_init_filters();
    return $r;
}
function seop_ai_autofix($meta_cap = 20, $alt_cap = 8, $media_cap = 20) {
    if (!seop_ai_ready()) return new WP_Error('seop_ai', 'This site has no connector API key yet — reload the SEO Platform settings page.');
    $report = ['ok' => true, 'ran_at' => current_time('mysql'), 'metas' => [], 'alts' => [], 'media_alts' => 0, 'skipped' => []];
    $site = get_bloginfo('name');
    // v1.5: the WHOLE site, not just posts/pages — themes and builders put real
    // content in custom post types (services, team, portfolio, …) and those
    // pages are audited like any other.
    $ptypes = array_values(array_diff(get_post_types(['public' => true]), ['attachment']));
    $posts = get_posts(['post_type' => $ptypes, 'post_status' => 'publish', 'numberposts' => 500, 'orderby' => 'modified', 'order' => 'DESC']);

    // 1) Missing OR WEAK SEO titles / meta descriptions. v1.4: the audit warns
    //    on out-of-range lengths (title 20–65, meta 70–165), so weak values get
    //    rewritten too — good values are still never touched, and Yoast/RM
    //    template values (%%…%%) are left alone (their length can't be judged).
    $weak = function ($v, $min, $max) {
        return $v !== '' && strpos($v, '%%') === false && (mb_strlen($v) < $min || mb_strlen($v) > $max);
    };
    $done = 0;
    foreach ($posts as $p) {
        if ($done >= $meta_cap) break;
        list($t, $d) = seop_existing_meta($p->ID);
        $needT = !$t || $weak($t, 20, 65);
        $needD = !$d || $weak($d, 70, 165);
        if (!$needT && !$needD) continue;
        $excerpt = mb_substr(wp_strip_all_tags($p->post_content), 0, 1200);
        $out = seop_claude(
            'You write SEO meta for web pages. Return ONLY compact JSON, no markdown: {"title":"50-60 char SEO title","description":"150-160 char meta description with a call to action"}.',
            "Site: {$site}. Page title: {$p->post_title}. Page content:\n{$excerpt}", 300
        );
        if (is_wp_error($out)) { $report['skipped'][] = $p->post_title . ' — ' . $out->get_error_message(); continue; }
        $j = json_decode(trim(preg_replace('/```json|```/', '', $out)), true);
        if (!is_array($j)) { $report['skipped'][] = $p->post_title . ' — unparseable AI reply'; continue; }
        seop_write_meta($p->ID, $needT ? ($j['title'] ?? null) : null, $needD ? ($j['description'] ?? null) : null, null);
        $report['metas'][] = $p->post_title . (($t || $d) ? ' (weak → rewritten)' : '');
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
            seop_save_rewritten($p->ID, $content);
            $report['alts'][] = $p->post_title . ' (' . count($alts) . ' images)';
        }
        update_post_meta($p->ID, '_seoplatform_alts_done', 1);
        $done++;
    }

    // 3) v1.3: MEDIA LIBRARY alt text. In-page alts (step 2) don't help images
    //    placed by themes/builders from the library — the attachment's own
    //    _wp_attachment_image_alt does. Fill missing ones, never overwrite.
    $atts = get_posts(['post_type' => 'attachment', 'post_mime_type' => 'image', 'post_status' => 'inherit',
        'numberposts' => $media_cap * 3, 'orderby' => 'date', 'order' => 'DESC',
        'meta_query' => [['key' => '_wp_attachment_image_alt', 'compare' => 'NOT EXISTS']]]);
    // Empty-string alts count as missing too; meta_query NOT EXISTS misses those.
    $atts = array_merge($atts, get_posts(['post_type' => 'attachment', 'post_mime_type' => 'image', 'post_status' => 'inherit',
        'numberposts' => $media_cap, 'meta_query' => [['key' => '_wp_attachment_image_alt', 'value' => '']]]));
    $todo = [];
    foreach ($atts as $a) {
        if (count($todo) >= $media_cap) break;
        if (get_post_meta($a->ID, '_wp_attachment_image_alt', true)) continue;
        if (isset($todo[$a->ID])) continue;
        $todo[$a->ID] = $a;
    }
    if ($todo) {
        $lines = []; $ids = array_keys($todo); $i = 1;
        foreach ($todo as $a) {
            $ctx = $a->post_title && strtolower($a->post_title) !== strtolower(pathinfo(get_attached_file($a->ID) ?: '', PATHINFO_FILENAME)) ? ' — title: ' . $a->post_title : '';
            $parent = $a->post_parent ? get_the_title($a->post_parent) : '';
            $lines[] = $i++ . '. ' . basename(get_attached_file($a->ID) ?: ($a->post_title ?: 'image')) . $ctx . ($parent ? ' — used on: ' . $parent : '');
        }
        $out = seop_claude(
            'You write concise, descriptive image alt text, max 12 words each. No quotes, no "image of". Return a numbered list only, one item per input line, same order.',
            'Site: ' . get_bloginfo('name') . ". Media library images (filename — context):\n" . implode("\n", $lines), 800
        );
        $alts = [];
        if (!is_wp_error($out)) {
            foreach (preg_split('/\r?\n/', $out) as $line) {
                if (preg_match('/^\s*(\d+)[.)]\s*(.+)$/', $line, $m)) $alts[(int) $m[1] - 1] = sanitize_text_field($m[2]);
            }
        } else {
            $report['skipped'][] = 'media alts — ' . $out->get_error_message() . ' (using filename fallback)';
        }
        foreach ($ids as $idx => $aid) {
            $alt = $alts[$idx] ?? seop_alt_from_filename(get_attached_file($aid) ?: '');
            if ($alt !== '') { update_post_meta($aid, '_wp_attachment_image_alt', $alt); $report['media_alts']++; }
        }
    }

    // 4) v1.4: INTERNAL LINKS. Every platform-imported page carries its focus
    //    keyword — link the first plain-text mention of that keyword on other
    //    published pages to it (one link per donor page, 10 per run, never
    //    inside existing links/headings, idempotent).
    $report['links'] = [];
    $targets = get_posts(['post_type' => ['post', 'page'], 'post_status' => 'publish', 'numberposts' => 30,
        'meta_key' => '_seoplatform_focus_keyword']);
    $linked = 0;
    foreach ($targets as $tp) {
        if ($linked >= 10) break;
        $kw = trim((string) get_post_meta($tp->ID, '_seoplatform_focus_keyword', true));
        if (mb_strlen($kw) < 6) continue; // too short to link safely
        $turl = get_permalink($tp->ID);
        foreach ($posts as $donor) {
            if ($linked >= 10) break;
            if ($donor->ID === $tp->ID) continue;
            $new = seop_link_keyword($donor->post_content, $kw, $turl);
            if ($new !== null) {
                seop_save_rewritten($donor->ID, $new);
                $report['links'][] = '"' . $donor->post_title . '" → "' . $tp->post_title . '" (' . $kw . ')';
                $linked++;
                break; // one inbound link per target per run is plenty
            }
        }
    }

    // 5a) v1.5.1: an EXISTING About page must carry credentials/trust language
    //     — the audit scans for the literal words (certified, licensed, award,
    //     accredited, years of experience). If the published about page has
    //     none, append one paragraph: the client's real credentials when the
    //     package delivered them, otherwise a general true-for-any-operating-
    //     business sentence. Idempotent (the appended text satisfies the scan).
    $bizT = seop_business();
    if (($bizT['name'] ?? '') !== '') {
        $aboutPub = get_posts(['post_type' => 'page', 'post_status' => 'publish', 'numberposts' => 1,
            'post_name__in' => ['about', 'about-us', 'our-team', 'our-story', 'team', 'meet-the-team']]);
        if ($aboutPub) {
            $pg = $aboutPub[0];
            $txt = strtolower(wp_strip_all_tags($pg->post_content));
            if (!preg_match('/certified|licensed|award|years of experience|accredited|board[- ]certified/', $txt)) {
                $sentence = seop_trust_sentence();
                $creds = trim((string) ($bizT['credentials'] ?? ''));
                $new = $pg->post_content . "\n\n<p>" . esc_html($sentence) . '</p>';
                seop_save_rewritten($pg->ID, $new);
                $report['about_trust'] = 'Trust/credentials paragraph added to "' . $pg->post_title . '"' . ($creds ? ' (from the client\'s stated credentials)' : ' (general — add real credentials in the platform intake for stronger copy)');
            }
        }
    }

    // 5b) v1.5: ABOUT PAGE. Two E-E-A-T checks read TEXT off the home/about
    //     pages: the about/team story and credentials language. If the site
    //     has no about-ish page at all, draft one from the approved business
    //     facts — unknown facts become [CLIENT TO CONFIRM: …], never invented.
    //     Lands as a DRAFT: a human fills the gaps and publishes.
    $biz = seop_business();
    if (($biz['name'] ?? '') !== '') {
        $aboutExists = get_posts(['post_type' => 'page', 'post_status' => ['publish', 'draft', 'future', 'pending'],
            'post_name__in' => ['about', 'about-us', 'our-team', 'our-story', 'team', 'meet-the-team'], 'numberposts' => 1]);
        if (!$aboutExists) {
            $facts = [];
            foreach (['name' => 'Business', 'type' => 'What they do', 'description' => 'Description',
                      'owner' => 'Owner (real person)', 'credentials' => 'Credentials (real — licenses/certs/awards/years)',
                      'city' => 'City', 'state' => 'State', 'phone' => 'Phone', 'hours' => 'Hours'] as $k => $lab) {
                if (($biz[$k] ?? '') !== '') $facts[] = $lab . ': ' . (is_array($biz[$k]) ? implode(', ', $biz[$k]) : $biz[$k]);
            }
            if (!empty($biz['services'])) $facts[] = 'Services: ' . implode(', ', (array) $biz['services']);
            $sa = (array) ($biz['service_area'] ?? []);
            $towns = array_filter(array_merge([$sa['primary'] ?? ''], (array) ($sa['secondary'] ?? [])));
            if ($towns) $facts[] = 'Service area: ' . implode(', ', $towns);
            $out = seop_claude(
                'You write About Us pages for local businesses. HARD RULES: use ONLY the facts provided — never invent people, years, certifications, awards, or testimonials. Where an important fact is missing (founding year, team members), write [CLIENT TO CONFIRM: what is needed]. No quotes from customers. TRUST LANGUAGE IS REQUIRED: if credentials are provided, state them verbatim; either way include one sentence with the literal phrase "years of experience" tied to the services (e.g. "brings years of experience in …") — a true statement for any operating business, with no specific number unless one was provided. Return clean HTML using <h2>/<h3>/<p> only (no <h1> — the page title is the H1). 250-400 words: who they are, what they do, the service area, why they can be trusted, and how to get in touch.',
                "Facts:\n" . implode("\n", $facts), 900
            );
            if (!is_wp_error($out) && trim($out) !== '') {
                $pid = wp_insert_post(['post_type' => 'page', 'post_status' => 'draft',
                    'post_title' => 'About Us', 'post_name' => 'about-us',
                    'post_content' => wp_kses_post(preg_replace('/<(\/?)h1\b/i', '<$1h2', $out))]);
                if ($pid && !is_wp_error($pid)) {
                    seop_write_meta($pid, 'About Us | ' . mb_substr($biz['name'], 0, 48), '', null);
                    $report['about'] = 'About Us page drafted from approved business facts — review it, fill any [CLIENT TO CONFIRM] gaps, and publish to lift the E-E-A-T grade.';
                }
            }
        }
    }

    // 5) v1.4: PRIVACY POLICY. The audit's E-E-A-T pillar fails sites without
    //    a linked privacy/legal page. Create WordPress's own core privacy
    //    template if the site has none (standard WP boilerplate, not invented
    //    facts) and register it so themes that show the privacy link pick it up.
    if (!get_option('wp_page_for_privacy_policy')) {
        // The class lives in wp-admin and isn't loaded on cron/REST runs — that
        // published an EMPTY "Privacy Policy" page. Load it, and skip if empty.
        if (!class_exists('WP_Privacy_Policy_Content') && file_exists(ABSPATH . 'wp-admin/includes/class-wp-privacy-policy-content.php')) {
            require_once ABSPATH . 'wp-admin/includes/class-wp-privacy-policy-content.php';
        }
        $tpl = class_exists('WP_Privacy_Policy_Content') && method_exists('WP_Privacy_Policy_Content', 'get_default_content')
            ? WP_Privacy_Policy_Content::get_default_content() : '';
        $pid = trim(wp_strip_all_tags($tpl)) === '' ? 0 : wp_insert_post(['post_type' => 'page', 'post_status' => 'publish',
            'post_title' => 'Privacy Policy', 'post_name' => 'privacy-policy', 'post_content' => $tpl]);
        if ($pid && !is_wp_error($pid)) {
            update_option('wp_page_for_privacy_policy', $pid);
            $report['privacy'] = 'Privacy Policy page created (WP core template) — review the text and make sure your footer/menu links it.';
        }
    }

    update_option(SEOP_OPT_AI_REPORT, $report);
    return $report;
}

/* v1.12: does a URL name this WordPress site? Host compared without "www.". */
function seop_same_site($url) {
    $h = strtolower((string) wp_parse_url($url, PHP_URL_HOST));
    $mine = strtolower((string) wp_parse_url(home_url('/'), PHP_URL_HOST));
    if ($h === '' || $mine === '') return false;
    return preg_replace('/^www\./', '', $h) === preg_replace('/^www\./', '', $mine);
}

/* v1.12: tell the platform when a piece it sent goes live. Fires when a
 * scheduled ("future") post publishes — WordPress's own cron does that — so
 * the account manager is tagged on the client's Trello card. Non-blocking:
 * a slow or unreachable platform never delays publishing. */
add_action('transition_post_status', function ($new, $old, $post) {
    if ($new !== 'publish' || $old !== 'future' || !($post instanceof WP_Post)) return;
    $external = (string) get_post_meta($post->ID, '_seoplatform_external_id', true);
    $key = (string) get_option(SEOP_KEY_OPT);
    if ($external === '' || $key === '') return;   // not platform content, or not connected
    wp_remote_post(SEOP_PLATFORM_EVENTS_URL, [
        'timeout' => 5, 'blocking' => false,
        'headers' => ['Authorization' => 'Bearer ' . $key, 'Content-Type' => 'application/json'],
        'body' => wp_json_encode([
            'event' => 'published', 'external_id' => $external, 'post_id' => $post->ID,
            'title' => get_the_title($post), 'url' => get_permalink($post), 'post_type' => $post->post_type,
            'published_at' => get_post_time('c', true, $post), 'site' => home_url('/'),
            'plugin_version' => SEOP_VERSION,
        ]),
    ]);
}, 10, 3);

/* ════════════════════════════════════════════════════════════════════════════
 * v1.13 — SITE EXPERIENCE FEATURES (each one switchable; the deploy package's
 * `features` block or Settings → SEO Platform sets them)
 *   · Performance: third-party chat widgets and reCAPTCHA load on the
 *     visitor's first interaction (scroll / tap / key / mouse), HTML is
 *     gzip-compressed when the server doesn't already, and new uploads get
 *     WebP sub-sizes so WordPress' responsive srcset serves WebP.
 *   · Branded share image for every page without one (1200×630 PNG: page
 *     title + business name, cached in uploads/seop-og/).
 *   · Business name, address and phone in the footer — only when the page
 *     doesn't already show that street address.
 *   · An "About <business>" E-E-A-T box under platform-written posts, written
 *     from the approved intake facts (owner, years, credentials, licenses).
 * ════════════════════════════════════════════════════════════════════════════ */
define('SEOP_OPT_FEATURES', 'seoplatform_features');
function seop_feature($k) {
    $defaults = ['delay_scripts' => 1, 'gzip' => 1, 'webp' => 1, 'og_images' => 1, 'footer_nap' => 1, 'eeat_box' => 1, 'brand_color' => '#1F2A44'];
    $f = get_option(SEOP_OPT_FEATURES);
    $f = is_array($f) ? array_merge($defaults, $f) : $defaults;
    return $f[$k] ?? null;
}
function seop_is_public_html_request() {
    return !is_admin() && !wp_doing_ajax() && !wp_doing_cron() && !(defined('REST_REQUEST') && REST_REQUEST)
        && !(defined('XMLRPC_REQUEST') && XMLRPC_REQUEST) && !is_feed() && !is_robots() && !is_customize_preview()
        && empty($_GET['elementor-preview']) && empty($_GET['fl_builder']) && empty($_GET['et_fb']);
}

// ── WebP sub-sizes for new uploads (WordPress 6.1+ image_editor_output_format)
add_filter('image_editor_output_format', function ($formats) {
    if (!seop_feature('webp') || !function_exists('wp_image_editor_supports') || !wp_image_editor_supports(['mime_type' => 'image/webp'])) return $formats;
    $formats['image/jpeg'] = 'image/webp';
    $formats['image/png'] = 'image/webp';
    return $formats;
});

// ── One output buffer for the HTML-level features (delay scripts, footer NAP)
// plus gzip underneath it when the server isn't compressing.
add_action('template_redirect', function () {
    if (!seop_is_public_html_request() || is_user_logged_in()) return;
    $gzip = seop_feature('gzip') && !ini_get('zlib.output_compression') && !headers_sent()
        && function_exists('ob_gzhandler') && extension_loaded('zlib')
        && stripos((string) ($_SERVER['HTTP_ACCEPT_ENCODING'] ?? ''), 'gzip') !== false
        // caching / optimization plugins compress (or cache) the page themselves
        && !defined('WP_ROCKET_VERSION') && !defined('W3TC') && !defined('LSCWP_V') && !defined('WPFC_WP_CONTENT_BASENAME')
        && !defined('AUTOPTIMIZE_PLUGIN_VERSION') && !class_exists('SiteGround_Optimizer\\Loader\\Loader') && !defined('BREEZE_VERSION');
    if ($gzip) ob_start('ob_gzhandler');
    if (seop_feature('delay_scripts') || seop_feature('footer_nap')) ob_start('seop_html_buffer');
}, 1);

// Scripts that never need to run before the visitor does something.
function seop_delay_patterns() {
    return apply_filters('seop_delay_script_patterns', [
        'google.com/recaptcha', 'gstatic.com/recaptcha', 'recaptcha.net/recaptcha',
        'leadconnectorhq.com', 'msgsndr.com', 'widgets.leadconnectorhq', 'link.msgsndr',
        'tawk.to', 'intercom', 'driftt.com', 'js.driftt', 'crisp.chat', 'livechatinc.com', 'static.zdassets.com',
        'js.hs-scripts.com', 'js.hsforms.net', 'usemessages.com', 'tidio', 'olark', 'birdeye', 'podium.com', 'smartsupp',
    ]);
}
function seop_html_buffer($html) {
    if (!is_string($html) || stripos($html, '</body>') === false || stripos($html, '<html') === false) return $html;
    if (seop_feature('delay_scripts')) {
        $pats = seop_delay_patterns(); $hit = 0;
        $html = preg_replace_callback('#<script\b([^>]*)\bsrc=(["\'])([^"\']+)\2([^>]*)>\s*</script>#i', function ($m) use ($pats, &$hit) {
            foreach ($pats as $p) {
                if (stripos($m[3], $p) !== false) {
                    $hit++;
                    $attrs = preg_replace('#\btype=(["\'])[^"\']*\1#i', '', $m[1] . ' ' . $m[4]);
                    return '<script type="text/seop-delay" data-seop-src="' . esc_attr($m[3]) . '"' . rtrim($attrs) . '></script>';
                }
            }
            return $m[0];
        }, $html);
        if ($hit) {
            $loader = "<script>(function(){var d=false;function go(){if(d)return;d=true;['scroll','touchstart','keydown','mousemove','click'].forEach(function(e){window.removeEventListener(e,go,{passive:true})});"
                . "document.querySelectorAll('script[type=\"text/seop-delay\"]').forEach(function(o){var s=document.createElement('script');for(var i=0;i<o.attributes.length;i++){var a=o.attributes[i];if(a.name!=='type'&&a.name!=='data-seop-src')s.setAttribute(a.name,a.value)}s.src=o.getAttribute('data-seop-src');o.parentNode.replaceChild(s,o)})}"
                . "['scroll','touchstart','keydown','mousemove','click'].forEach(function(e){window.addEventListener(e,go,{passive:true})});"
                . "document.addEventListener('focusin',function(e){if(e.target&&e.target.form)go()});setTimeout(go,15000)})();</script>";
            $html = preg_replace('#</body>#i', $loader . "\n</body>", $html, 1);
        }
    }
    if (seop_feature('footer_nap')) {
        $b = seop_business();
        $street = trim((string) ($b['street'] ?? ''));
        if ($street !== '' && ($b['name'] ?? '')) {
            $plain = seop_norm(preg_replace('#<script\b[\s\S]*?</script>#i', ' ', $html));
            if (strpos($plain, seop_norm($street)) === false) {
                $line2 = trim(implode(', ', array_filter([$street, $b['city'] ?? '', trim(($b['state'] ?? '') . ' ' . ($b['zip'] ?? ''))])));
                $tel = preg_replace('/[^0-9+]/', '', (string) ($b['phone'] ?? ''));
                $nap = '<address class="seop-nap" style="text-align:center;font-size:13px;font-style:normal;line-height:1.5;margin:16px auto;opacity:.85">'
                    . '<strong>' . esc_html($b['name']) . '</strong><br>' . esc_html($line2)
                    . ($tel ? '<br><a href="tel:' . esc_attr($tel) . '">' . esc_html($b['phone']) . '</a>' : '') . '</address>';
                $html = preg_replace('#</body>#i', $nap . "\n</body>", $html, 1);
            }
        }
    }
    return $html;
}

// ── Branded share images ────────────────────────────────────────────────────
function seop_og_image_url($pid) {
    if (!seop_feature('og_images') || !function_exists('imagecreatetruecolor') || !function_exists('imagettftext')) return '';
    $font = __DIR__ . '/assets/DejaVuSans-Bold.ttf';
    if (!is_readable($font)) return '';
    $b = seop_business();
    $biz = ($b['name'] ?? '') ?: get_bloginfo('name');
    $title = $pid ? html_entity_decode(get_the_title($pid), ENT_QUOTES, 'UTF-8') : (($b['description'] ?? '') ? $biz : get_bloginfo('description'));
    if ($pid && (int) get_option('page_on_front') === (int) $pid) $title = $biz;
    $title = trim($title) ?: $biz;
    $sub = trim(implode(' · ', array_filter([$pid && $title !== $biz ? $biz : '', trim(($b['city'] ?? '') . (($b['state'] ?? '') ? ', ' . $b['state'] : '')), wp_parse_url(home_url(), PHP_URL_HOST)])));
    $color = (string) seop_feature('brand_color');
    if (!preg_match('/^#[0-9a-f]{6}$/i', $color)) $color = '#1F2A44';
    $up = wp_upload_dir();
    if (!empty($up['error'])) return '';
    $dir = trailingslashit($up['basedir']) . 'seop-og'; $url = trailingslashit($up['baseurl']) . 'seop-og';
    $key = ($pid ?: 'home') . '-' . substr(md5($title . '|' . $sub . '|' . $color . '|v1'), 0, 10);
    $file = "$dir/$key.png";
    if (file_exists($file)) return "$url/$key.png";
    if (!wp_mkdir_p($dir)) return '';
    foreach ((array) glob("$dir/" . ($pid ?: 'home') . '-*.png') as $old) @unlink($old);   // title changed → replace
    $W = 1200; $H = 630; $im = imagecreatetruecolor($W, $H);
    $rgb = sscanf($color, '#%02x%02x%02x');
    imagefilledrectangle($im, 0, 0, $W, $H, imagecolorallocate($im, $rgb[0], $rgb[1], $rgb[2]));
    $white = imagecolorallocate($im, 255, 255, 255); $soft = imagecolorallocatealpha($im, 255, 255, 255, 40);
    imagefilledrectangle($im, 80, 96, 200, 104, $white);   // small rule above the title
    // wrap + fit the title: largest size (64→36) that fits in 3 lines
    $wrap = function ($text, $size) use ($font) {
        $lines = []; $line = '';
        foreach (preg_split('/\s+/u', $text) as $w) {
            $try = $line === '' ? $w : "$line $w";
            $bb = imagettfbbox($size, 0, $font, $try);
            if ($bb[2] - $bb[0] > 1040 && $line !== '') { $lines[] = $line; $line = $w; } else $line = $try;
        }
        if ($line !== '') $lines[] = $line;
        return $lines;
    };
    for ($size = 64; $size >= 36; $size -= 4) { $lines = $wrap($title, $size); if (count($lines) <= 3) break; }
    $lines = array_slice($lines, 0, 3);
    $y = 150 + $size;
    foreach ($lines as $ln) { imagettftext($im, $size, 0, 80, $y, $white, $font, $ln); $y += (int) ($size * 1.35); }
    if ($sub !== '') {
        $sub = mb_substr($sub, 0, 90);
        for ($ss = 26; $ss > 16; $ss -= 2) { $bb = imagettfbbox($ss, 0, $font, $sub); if ($bb[2] - $bb[0] <= 1040) break; }
        imagettftext($im, $ss, 0, 80, $H - 80, $soft, $font, $sub);
    }
    $ok = imagepng($im, $file, 6);
    imagedestroy($im);
    return $ok ? "$url/$key.png" : '';
}
function seop_og_target_id() {
    if (is_front_page()) return (int) get_option('page_on_front');
    return is_singular() ? (int) get_queried_object_id() : -1;
}
// Yoast: add ours only when the page has no image of its own.
add_action('wpseo_add_opengraph_images', function ($container) {
    $pid = seop_og_target_id(); if ($pid < 0 || !is_object($container) || $container->has_images()) return;
    $u = seop_og_image_url($pid); if ($u) $container->add_image(['url' => $u, 'width' => 1200, 'height' => 630]);
});
// Rank Math
add_filter('rank_math/opengraph/facebook/image', function ($img) {
    if ($img) return $img; $pid = seop_og_target_id(); return $pid < 0 ? $img : (seop_og_image_url($pid) ?: $img);
});
add_filter('rank_math/opengraph/twitter/image', function ($img) {
    if ($img) return $img; $pid = seop_og_target_id(); return $pid < 0 ? $img : (seop_og_image_url($pid) ?: $img);
});
// No SEO plugin: print og:image / twitter:image ourselves (featured image wins).
add_action('wp_head', function () {
    if (seop_seo_plugin() !== 'none' || !seop_feature('og_images')) return;
    $pid = seop_og_target_id(); if ($pid < 0) return;
    $og = $pid ? (string) get_post_meta($pid, '_seoplatform_og_tags', true) : '';
    if ($og && stripos($og, 'og:image') !== false && strpos($og, '[IMAGE_URL]') === false) return;   // imported tags carry a real image
    $img = $pid && has_post_thumbnail($pid) ? (string) get_the_post_thumbnail_url($pid, 'full') : seop_og_image_url($pid);
    if (!$img) return;
    echo "\n<meta property=\"og:image\" content=\"" . esc_url($img) . "\">\n<meta property=\"og:image:width\" content=\"1200\">\n<meta property=\"og:image:height\" content=\"630\">\n<meta name=\"twitter:card\" content=\"summary_large_image\">\n<meta name=\"twitter:image\" content=\"" . esc_url($img) . "\">\n";
}, 21);
// ── E-E-A-T box under platform-written posts ────────────────────────────────
add_filter('the_content', function ($content) {
    if (!seop_feature('eeat_box') || !is_singular('post') || !in_the_loop() || !is_main_query()) return $content;
    $pid = get_the_ID();
    if (!get_post_meta($pid, '_seoplatform_external_id', true)) return $content;   // only pieces the platform wrote
    $b = seop_business();
    $about = trim((string) ($b['about_text'] ?? ''));
    if ($about === '' || !($b['name'] ?? '')) return $content;
    return $content . '<aside class="seop-about" style="margin:32px 0 8px;padding:18px 20px;border:1px solid rgba(0,0,0,.12);border-radius:10px;font-size:.95em">'
        . '<strong>About ' . esc_html($b['name']) . '</strong><p style="margin:.5em 0 0">' . esc_html($about) . '</p></aside>';
}, 98);

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
    if (isset($_POST['seop_feat_save']) && check_admin_referer('seop_feat')) {
        $cur = [];
        foreach (['delay_scripts', 'gzip', 'webp', 'og_images', 'footer_nap', 'eeat_box'] as $k) $cur[$k] = empty($_POST['seop_f_' . $k]) ? 0 : 1;
        $c = sanitize_text_field(wp_unslash($_POST['seop_f_brand_color'] ?? ''));
        $cur['brand_color'] = preg_match('/^#[0-9a-f]{6}$/i', $c) ? $c : '#1F2A44';
        update_option(SEOP_OPT_FEATURES, $cur);
        echo '<div class="notice notice-success"><p>Site features saved.</p></div>';
    }
    if (isset($_POST['seop_ai_save']) && check_admin_referer('seop_ai')) {
        $cron = !empty($_POST['seop_ai_cron']);
        update_option(SEOP_OPT_AI_CRON, $cron ? 1 : 0);
        wp_clear_scheduled_hook('seop_ai_autofix_event');
        if ($cron) wp_schedule_event(time() + HOUR_IN_SECONDS, 'seop_weekly', 'seop_ai_autofix_event');
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
    echo '<p>Upload the <code>deploy-*.json</code> file exported from the SEO platform (the “Deploy file” button). It applies SEO meta, schema, social tags, robots.txt, llms.txt, redirects, security headers, and creates/schedules the content — all in one shot.</p>';
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
    echo '<p>The connector fixes what the audit grades: missing <strong>and weak</strong> SEO titles/descriptions, image alt text (page content <em>and</em> the media library), internal links to the campaign\'s target pages, and a Privacy Policy page if the site has none. Default security headers, FAQ schema from existing Q&amp;A headings, and an llms.txt fallback are always on — on demand, on a weekly schedule, or triggered by the platform. It never overwrites values that already exist.</p>';
    $hasAiKey = seop_ai_ready();
    echo '<form method="post">' . wp_nonce_field('seop_ai', '_wpnonce', true, false);
    echo '<table class="form-table">';
    if (seop_ai_key() !== '') {
        echo '<tr><th>AI</th><td><em>Using this host\'s own Anthropic key (set in wp-config.php).</em></td></tr>';
    } else {
        echo '<tr><th>AI</th><td><em>Provided by the SEO Platform — no key to enter. Importing a deploy file connects the site automatically.</em></td></tr>';
    }
    echo '<tr><th>Weekly auto-fix</th><td><label><input type="checkbox" name="seop_ai_cron" value="1"' . (get_option(SEOP_OPT_AI_CRON) ? ' checked' : '') . '> Run automatically every week (keeps new pages covered)</label></td></tr>';
    echo '</table><p><button class="button" name="seop_ai_save" value="1">Save AI settings</button></p></form>';
    if ($hasAiKey) {
        echo '<form method="post">' . wp_nonce_field('seop_ai_go', '_wpnonce', true, false);
        echo '<p><button class="button button-primary" name="seop_ai_run" value="1">Run AI auto-fix now</button> <em>Per run: 20 pages of metas (missing/weak) across ALL public post types, 8 pages of in-content alts, 20 media-library alts, 10 internal links — plus an About Us draft and Privacy Policy page when the site lacks them.</em></p></form>';
    }
    $lastAi = $aiReport && !is_wp_error($aiReport) ? $aiReport : get_option(SEOP_OPT_AI_REPORT);
    if ($aiReport && is_wp_error($aiReport)) {
        echo '<div class="notice notice-error"><p>' . esc_html($aiReport->get_error_message()) . '</p></div>';
    }
    if (is_array($lastAi) && !empty($lastAi['ran_at'])) {
        echo '<p><strong>Last AI run:</strong> ' . esc_html($lastAi['ran_at']) . ' — ' . count($lastAi['metas'] ?? []) . ' pages got metas, ' . count($lastAi['alts'] ?? []) . ' pages got alts, ' . (int) ($lastAi['media_alts'] ?? 0) . ' media-library alts, ' . count($lastAi['links'] ?? []) . ' internal links' . (!empty($lastAi['about']) ? ' · About Us drafted' : '') . (!empty($lastAi['about_trust']) ? ' · trust language added to About' : '') . (!empty($lastAi['skipped']) ? ', ' . count($lastAi['skipped']) . ' skipped' : '') . '.</p>';
        if (!empty($lastAi['skipped'])) {
            echo '<ul style="list-style:disc;margin-left:20px">';
            foreach ($lastAi['skipped'] as $line) echo '<li>' . esc_html($line) . '</li>';
            echo '</ul>';
        }
    }

    // v1.13: site-experience switches
    $labels = [
        'delay_scripts' => 'Load chat widgets and reCAPTCHA on the visitor\'s first interaction (faster first paint)',
        'gzip' => 'Compress pages (gzip) when the server doesn\'t already',
        'webp' => 'Create WebP versions of new uploads (served automatically via srcset)',
        'og_images' => 'Branded share image for pages without one',
        'footer_nap' => 'Business name, address and phone in the footer (only when the page doesn\'t show the address)',
        'eeat_box' => '"About the business" box under platform-written posts',
    ];
    echo '<h2>Site features</h2><form method="post">' . wp_nonce_field('seop_feat', '_wpnonce', true, false) . '<table class="form-table">';
    foreach ($labels as $k => $l) echo '<tr><th>' . esc_html(ucwords(str_replace('_', ' ', $k))) . '</th><td><label><input type="checkbox" name="seop_f_' . $k . '" value="1"' . checked((bool) seop_feature($k), true, false) . '> ' . esc_html($l) . '</label></td></tr>';
    echo '<tr><th>Share image color</th><td><input type="text" name="seop_f_brand_color" value="' . esc_attr(seop_feature('brand_color')) . '" pattern="#[0-9a-fA-F]{6}" style="width:110px"> <span class="description">background of the branded share images</span></td></tr>';
    echo '</table><p><button class="button" name="seop_feat_save" value="1">Save site features</button></p></form>';

    echo '<h2>Connection</h2><table class="form-table">';
    echo '<tr><th>REST base URL</th><td><code>' . esc_html($base) . '</code></td></tr>';
    echo '<tr><th>API key</th><td><code>' . esc_html($key) . '</code><p class="description">Set automatically when you import a deploy file from the SEO platform — nothing to copy. Regenerating it disconnects the site until the next import.</p></td></tr>';
    echo '<tr><th>Active SEO plugin</th><td><code>' . esc_html(seop_seo_plugin()) . '</code></td></tr>';
    echo '<tr><th>Connector version</th><td><code>' . esc_html(SEOP_VERSION) . '</code></td></tr>';
    $biz = seop_business();
    echo '<tr><th>Business profile</th><td>' . (($biz['name'] ?? '') ? '<code>' . esc_html($biz['name']) . '</code> — site-wide LocalBusiness/E-E-A-T schema active' : '<em>not loaded — import a deploy package that includes business facts (SEO platform V5.1.1+)</em>') . '</td></tr>';
    echo '</table>';
    echo '<form method="post">' . wp_nonce_field('seop_regen', '_wpnonce', true, false);
    echo '<p><button class="button" name="seop_regen" value="1">Regenerate API key</button></p></form>';
    echo '</div>';
}
