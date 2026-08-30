<?php

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Fires a push campaign automatically when a post is first published,
 * gated by the "Auto notify on publish" setting.
 */
final class MPP_Publish_Hook {

    public static function init() {
        add_action('transition_post_status', array(__CLASS__, 'maybe_notify'), 10, 3);
    }

    public static function maybe_notify($new_status, $old_status, $post) {
        if ($new_status !== 'publish' || $old_status === 'publish') {
            return;
        }

        if ($post->post_type !== 'post') {
            return;
        }

        if (!get_option('mpp_auto_notify')) {
            return;
        }

        $template = (string) get_option('mpp_message_template', 'New post: {post_title}');
        $body     = str_replace('{post_title}', get_the_title($post), $template);

        $payload = array(
            'title'   => get_the_title($post),
            'body'    => $body,
            'url'     => get_permalink($post),
            'icon'    => (string) get_option('mpp_default_icon'),
            'siteIds' => array(sanitize_text_field(get_option('mpp_site_key'))),
        );

        $result = MPP_API::create_campaign($payload, 'post-' . $post->ID);

        if (!is_wp_error($result) && !empty($result['id'])) {
            MPP_API::start_processing($result['id']);
        }
    }
}
