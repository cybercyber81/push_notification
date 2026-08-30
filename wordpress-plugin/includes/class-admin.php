<?php

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Admin settings screen and manual campaign send screen.
 * All actions here require manage_options; the campaign API key never
 * leaves the server, so a regular visitor cannot reach the push platform.
 */
final class MPP_Admin {

    const CAPABILITY = 'manage_options';

    public static function init() {
        add_action('admin_menu', array(__CLASS__, 'add_menu'));
        add_action('admin_init', array(__CLASS__, 'register_settings'));
    }

    public static function add_menu() {
        add_options_page(
            'Private Push',
            'Private Push',
            self::CAPABILITY,
            'mpp-settings',
            array(__CLASS__, 'render_settings_page')
        );

        add_management_page(
            'Send Push Notification',
            'Send Push Notification',
            self::CAPABILITY,
            'mpp-send',
            array(__CLASS__, 'render_send_page')
        );
    }

    public static function register_settings() {
        register_setting('mpp_settings_group', 'mpp_api_url', array('sanitize_callback' => 'esc_url_raw'));
        register_setting('mpp_settings_group', 'mpp_site_key', array('sanitize_callback' => 'sanitize_text_field'));
        register_setting('mpp_settings_group', 'mpp_api_key', array('sanitize_callback' => 'sanitize_text_field'));
        register_setting('mpp_settings_group', 'mpp_enable_frontend', array('sanitize_callback' => 'absint'));
        register_setting('mpp_settings_group', 'mpp_auto_notify', array('sanitize_callback' => 'absint'));
        register_setting('mpp_settings_group', 'mpp_default_icon', array('sanitize_callback' => 'esc_url_raw'));
        register_setting('mpp_settings_group', 'mpp_default_badge', array('sanitize_callback' => 'esc_url_raw'));
        register_setting('mpp_settings_group', 'mpp_message_template', array('sanitize_callback' => 'sanitize_text_field'));
    }

    public static function render_settings_page() {
        if (!current_user_can(self::CAPABILITY)) {
            wp_die(esc_html__('You do not have permission to access this page.'));
        }
        ?>
        <div class="wrap">
            <h1>Private Push Settings</h1>
            <form method="post" action="options.php">
                <?php settings_fields('mpp_settings_group'); ?>
                <table class="form-table">
                    <tr>
                        <th><label for="mpp_api_url">Push API URL</label></th>
                        <td><input type="url" id="mpp_api_url" name="mpp_api_url" class="regular-text" value="<?php echo esc_attr(get_option('mpp_api_url')); ?>" placeholder="https://push.example.com"></td>
                    </tr>
                    <tr>
                        <th><label for="mpp_site_key">Site Key</label></th>
                        <td><input type="text" id="mpp_site_key" name="mpp_site_key" class="regular-text" value="<?php echo esc_attr(get_option('mpp_site_key')); ?>"></td>
                    </tr>
                    <tr>
                        <th><label for="mpp_api_key">Private API Key</label></th>
                        <td><input type="password" id="mpp_api_key" name="mpp_api_key" class="regular-text" value="<?php echo esc_attr(get_option('mpp_api_key')); ?>" autocomplete="off"></td>
                    </tr>
                    <tr>
                        <th>Enable frontend subscription</th>
                        <td><label><input type="checkbox" name="mpp_enable_frontend" value="1" <?php checked(get_option('mpp_enable_frontend'), 1); ?>> Yes</label></td>
                    </tr>
                    <tr>
                        <th>Auto notify on publish</th>
                        <td><label><input type="checkbox" name="mpp_auto_notify" value="1" <?php checked(get_option('mpp_auto_notify'), 1); ?>> Yes</label></td>
                    </tr>
                    <tr>
                        <th><label for="mpp_default_icon">Default notification icon</label></th>
                        <td><input type="url" id="mpp_default_icon" name="mpp_default_icon" class="regular-text" value="<?php echo esc_attr(get_option('mpp_default_icon')); ?>"></td>
                    </tr>
                    <tr>
                        <th><label for="mpp_default_badge">Default badge</label></th>
                        <td><input type="url" id="mpp_default_badge" name="mpp_default_badge" class="regular-text" value="<?php echo esc_attr(get_option('mpp_default_badge')); ?>"></td>
                    </tr>
                    <tr>
                        <th><label for="mpp_message_template">Default message template</label></th>
                        <td><input type="text" id="mpp_message_template" name="mpp_message_template" class="regular-text" value="<?php echo esc_attr(get_option('mpp_message_template', 'New post: {post_title}')); ?>"></td>
                    </tr>
                </table>
                <?php submit_button(); ?>
            </form>
        </div>
        <?php
    }

    public static function render_send_page() {
        if (!current_user_can(self::CAPABILITY)) {
            wp_die(esc_html__('You do not have permission to access this page.'));
        }

        $notice = '';

        if (isset($_POST['mpp_send_nonce']) && wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['mpp_send_nonce'])), 'mpp_send_campaign')) {
            if (!current_user_can(self::CAPABILITY)) {
                wp_die(esc_html__('You do not have permission to perform this action.'));
            }

            $payload = array(
                'title'   => sanitize_text_field(wp_unslash($_POST['mpp_title'] ?? '')),
                'body'    => sanitize_textarea_field(wp_unslash($_POST['mpp_body'] ?? '')),
                'url'     => esc_url_raw(wp_unslash($_POST['mpp_url'] ?? '')),
                'icon'    => esc_url_raw(wp_unslash($_POST['mpp_icon'] ?? '')),
                'siteIds' => array(sanitize_text_field(get_option('mpp_site_key'))),
            );

            $result = MPP_API::create_campaign($payload);

            if (is_wp_error($result)) {
                $notice = '<div class="notice notice-error"><p>' . esc_html($result->get_error_message()) . '</p></div>';
            } else {
                $campaign_id = $result['id'] ?? null;
                if ($campaign_id) {
                    MPP_API::start_processing($campaign_id);
                }
                $notice = '<div class="notice notice-success"><p>Campaign created and processing started.</p></div>';
            }
        }
        ?>
        <div class="wrap">
            <h1>Send Push Notification</h1>
            <?php echo $notice; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
            <form method="post">
                <?php wp_nonce_field('mpp_send_campaign', 'mpp_send_nonce'); ?>
                <table class="form-table">
                    <tr>
                        <th><label for="mpp_title">Title</label></th>
                        <td><input type="text" id="mpp_title" name="mpp_title" class="regular-text" required></td>
                    </tr>
                    <tr>
                        <th><label for="mpp_body">Message</label></th>
                        <td><textarea id="mpp_body" name="mpp_body" class="large-text" rows="4"></textarea></td>
                    </tr>
                    <tr>
                        <th><label for="mpp_url">Target URL</label></th>
                        <td><input type="url" id="mpp_url" name="mpp_url" class="regular-text"></td>
                    </tr>
                    <tr>
                        <th><label for="mpp_icon">Icon</label></th>
                        <td><input type="url" id="mpp_icon" name="mpp_icon" class="regular-text"></td>
                    </tr>
                </table>
                <?php submit_button('Send Notification'); ?>
            </form>
        </div>
        <?php
    }
}
