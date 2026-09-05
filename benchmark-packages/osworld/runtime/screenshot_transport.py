"""Explicit screenshot-only transport for slow local TCG guests.

The default leaves the SDK instance untouched. The opt-in method follows
PythonController.get_screenshot from SDK d578d2d4: same retry count, interval,
payload validation and failure result; only the HTTP request timeout differs.
SDK source files and unrelated controller requests are never changed.
"""
import logging
import time
from types import MethodType

logger = logging.getLogger(__name__)


def validate_screenshot_timeout(value):
    if type(value) is not int or not 10 <= value <= 120:
        raise ValueError('screenshot HTTP timeout must be an integer from 10 to 120 seconds')
    return value


def transport_profile(timeout_sec):
    validate_screenshot_timeout(timeout_sec)
    return {'protocol': 'osworld-screenshot-transport@1',
            'mode': 'sdk-default' if timeout_sec == 10 else 'custom-http-timeout',
            'http_timeout_sec': timeout_sec, 'retry_times': 3, 'retry_interval_sec': 5}


def configure_screenshot_transport(controller, timeout_sec):
    validate_screenshot_timeout(timeout_sec)
    if timeout_sec == 10:
        return
    import requests
    if controller.retry_times != 3 or controller.retry_interval != 5:
        raise ValueError('screenshot retries differ from the pinned SDK')

    def get_screenshot(self):
        for attempt_idx in range(self.retry_times):
            try:
                response = requests.get(self.http_server + '/screenshot', timeout=timeout_sec)
                if response.status_code == 200:
                    content_type = response.headers.get('Content-Type', '')
                    content = response.content
                    if self._is_valid_image_response(content_type, content):
                        logger.info('Got screenshot successfully')
                        return content
                    logger.error('Invalid screenshot payload (attempt %d/%d).', attempt_idx + 1, self.retry_times)
                else:
                    logger.error('Failed to get screenshot. Status code: %d', response.status_code)
            except Exception as error:
                # Matches the pinned SDK's catch/retry behavior. Avoid echoing
                # response bodies or credentials into the private worker log.
                logger.error('Screenshot request failed: %s', type(error).__name__)
            time.sleep(self.retry_interval)
        logger.error('Failed to get screenshot.')
        return None

    controller.get_screenshot = MethodType(get_screenshot, controller)
