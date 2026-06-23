<?php
/**
 * Plugin Name: 44i SEO Platform Connector
 * Description: Securely receives SEO metadata, JSON-LD schema, and content drafts from the 44i SEO platform. SEO-ONLY — it never changes your site's appearance, theme, layout, menus, or settings, and new content is created as a draft for human review.
 * Version: 1.0.0
 * Author: 44i Digital
 * License: GPL-2.0+
 */

if (!defined('ABSPATH')) exit;

define('SEOP_NS', 'seo-platform/v1');
define('SEOP_KEY_OPT', 'seoplatform_api_key');
define('SEOP_VERSION', '1.0.0');

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
});

function seop_status() {
    return [
        'ok' => true,
        'connector_version' => SEOP_VERSION,
        'wp_version' => get_bloginfo('version'),
        'seo_plugin' => seop_seo_plugin(),
        'site' => home_url(),
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

/* Create/update a content draft. Defaults to DRAFT — nothing is published without human review. */
function seop_content($request) {
    $p = $request->get_json_params();
    $title   = isset($p['title']) ? sanitize_text_field($p['title']) : '';
    $content = isset($p['content']) ? wp_kses_post($p['content']) : '';
    $excerpt = isset($p['excerpt']) ? sanitize_text_field($p['excerpt']) : '';
    $type    = (isset($p['post_type']) && $p['post_type'] === 'page') ? 'page' : 'post';
    $status  = (isset($p['status']) && $p['status'] === 'publish') ? 'publish' : 'draft';
    $external = isset($p['external_id']) ? sanitize_text_field($p['external_id']) : '';
    if ($title === '' && $content === '') {
        return new WP_Error('seop_empty', 'title or content required', ['status' => 400]);
    }
    $existing = seop_find_by_external($external);
    $data = [
        'post_title' => $title, 'post_content' => $content, 'post_excerpt' => $excerpt,
        'post_status' => $status, 'post_type' => $type,
    ];
    if ($existing) { $data['ID'] = $existing; $id = wp_update_post($data, true); }
    else           { $id = wp_insert_post($data, true); }
    if (is_wp_error($id)) return $id;
    if ($external) update_post_meta($id, '_seoplatform_external_id', $external);
    if (!empty($p['focus_keyword'])) update_post_meta($id, '_seoplatform_focus_keyword', sanitize_text_field($p['focus_keyword']));
    if (!empty($p['seo_title']) || !empty($p['seo_description'])) {
        seop_write_meta($id, $p['seo_title'] ?? null, $p['seo_description'] ?? null, null);
    }
    return [
        'ok' => true, 'post_id' => $id, 'status' => $status,
        'edit_url' => admin_url('post.php?post=' . $id . '&action=edit'),
        'view_url' => get_permalink($id),
    ];
}

function seop_seo_meta($request) {
    $p = $request->get_json_params();
    $id = seop_resolve_target($p['target'] ?? '');
    if (!$id) return new WP_Error('seop_target', 'could not resolve target page', ['status' => 404]);
    seop_write_meta($id, $p['seo_title'] ?? null, $p['seo_description'] ?? null, $p['canonical'] ?? null);
    return ['ok' => true, 'post_id' => $id, 'seo_plugin' => seop_seo_plugin()];
}

/* Store JSON-LD for a page; output it in the <head> (invisible to visitors). */
function seop_schema($request) {
    $p = $request->get_json_params();
    $id = seop_resolve_target($p['target'] ?? '');
    if (!$id) return new WP_Error('seop_target', 'could not resolve target page', ['status' => 404]);
    $jsonld = $p['jsonld'] ?? null;
    if (is_array($jsonld)) $jsonld = wp_json_encode($jsonld);
    if (!is_string($jsonld) || json_decode($jsonld) === null) {
        return new WP_Error('seop_jsonld', 'invalid JSON-LD', ['status' => 400]);
    }
    update_post_meta($id, '_seoplatform_schema', wp_slash($jsonld));
    return ['ok' => true, 'post_id' => $id];
}

add_action('wp_head', function () {
    if (!is_singular()) return;
    $jsonld = get_post_meta(get_queried_object_id(), '_seoplatform_schema', true);
    if ($jsonld) echo "\n<script type=\"application/ld+json\">" . $jsonld . "</script>\n";
}, 20);

/* Settings screen: shows the REST base + API key to paste into the platform. */
add_action('admin_menu', function () {
    add_options_page('SEO Platform Connector', 'SEO Platform', 'manage_options', 'seo-platform', 'seop_settings_page');
});
function seop_settings_page() {
    if (!current_user_can('manage_options')) return;
    if (isset($_POST['seop_regen']) && check_admin_referer('seop_regen')) {
        update_option(SEOP_KEY_OPT, wp_generate_password(48, false, false));
        echo '<div class="notice notice-success"><p>New API key generated.</p></div>';
    }
    $key  = get_option(SEOP_KEY_OPT);
    $base = rest_url(SEOP_NS);
    echo '<div class="wrap"><h1>SEO Platform Connector</h1>';
    echo '<p><strong>SEO-only.</strong> This connector never changes your site\'s appearance, theme, layout, or settings. New content arrives as a draft for your review.</p>';
    echo '<table class="form-table">';
    echo '<tr><th>REST base URL</th><td><code>' . esc_html($base) . '</code></td></tr>';
    echo '<tr><th>API key</th><td><code>' . esc_html($key) . '</code></td></tr>';
    echo '<tr><th>Active SEO plugin</th><td><code>' . esc_html(seop_seo_plugin()) . '</code></td></tr>';
    echo '</table>';
    echo '<form method="post">' . wp_nonce_field('seop_regen', '_wpnonce', true, false);
    echo '<p><button class="button" name="seop_regen" value="1">Regenerate API key</button></p></form>';
    echo '</div>';
}
