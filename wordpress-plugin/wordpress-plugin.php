<?php
/**
 * Plugin Name: My Private Push
 * Description: Connects this WordPress site to a private Web Push platform.
 * Version: 1.0.0
 */

if (!defined('ABSPATH')) {
    exit;
}

define('MPP_VERSION', '1.0.0');
define('MPP_PATH', plugin_dir_path(__FILE__));
define('MPP_URL', plugin_dir_url(__FILE__));

require_once MPP_PATH . 'includes/class-admin.php';
require_once MPP_PATH . 'includes/class-api.php';
require_once MPP_PATH . 'includes/class-publish-hook.php';
require_once MPP_PATH . 'includes/class-service-worker.php';

MPP_Admin::init();
MPP_Publish_Hook::init();
MPP_Service_Worker::init();
