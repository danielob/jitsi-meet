/* @flow */

import { setRoom } from '../base/conference';
import {
    configWillLoad,
    loadConfigError,
    setConfig,
    setConfigFromURLParams
} from '../base/config';
import { setLocationURL } from '../base/connection';
import { loadConfig } from '../base/lib-jitsi-meet';
import { getProfile } from '../base/profile';
import { parseURIString } from '../base/util';

import { APP_WILL_MOUNT, APP_WILL_UNMOUNT } from './actionTypes';

declare var APP: Object;

/**
 * Triggers an in-app navigation to a specific route. Allows navigation to be
 * abstracted between the mobile/React Native and Web/React applications.
 *
 * @param {(string|undefined)} uri - The URI to which to navigate. It may be a
 * full URL with an HTTP(S) scheme, a full or partial URI with the app-specific
 * scheme, or a mere room name.
 * @returns {Function}
 */
export function appNavigate(uri: ?string) {
    return (dispatch: Dispatch<*>, getState: Function) =>
        _appNavigateToOptionalLocation(dispatch, getState, parseURIString(uri));
}

/**
 * Triggers an in-app navigation to a specific location URI.
 *
 * @param {Dispatch} dispatch - The redux {@code dispatch} function.
 * @param {Function} getState - The redux function that gets/retrieves the redux
 * state.
 * @param {Object} newLocation - The location URI to navigate to. The value
 * cannot be undefined and is assumed to have all properties such as
 * {@code host}, {@code contextRoot}, and {@code room} defined. Depending on the
 * property, it may have a value equal to {@code undefined} and that may be
 * acceptable.
 * @private
 * @returns {Promise<void>}
 */
function _appNavigateToMandatoryLocation(
        dispatch: Dispatch<*>, getState: Function,
        newLocation: Object
): Promise<void> {
    const { room } = newLocation;

    dispatch(configWillLoad(newLocation));

    return (
        _loadConfig(newLocation)
            .then(
                config => loadConfigSettled(/* error */ undefined, config),
                error => loadConfigSettled(error, /* config */ undefined))
            .then(() => dispatch(setRoom(room))));

    /**
     * Notifies that an attempt to load a configuration has completed. Due to
     * the asynchronous nature of the loading, the specified {@code config} may
     * or may not be required by the time the notification arrives.
     *
     * @param {string|undefined} error - If the loading has failed, the error
     * detailing the cause of the failure.
     * @param {Object|undefined} config - If the loading has succeeded, the
     * loaded configuration.
     * @returns {void}
     */
    function loadConfigSettled(error, config) {
        // FIXME Due to the asynchronous nature of the loading, the specified
        // config may or may not be required by the time the notification
        // arrives.

        // Now that the loading of the config was successful override the values
        // with the parameters passed in the hash part of the location URI.
        // TODO We're still in the middle ground between old Web with config,
        // interfaceConfig, and loggingConfig used via global variables and new
        // Web and mobile reading the respective values from the redux store.
        // On React Native there's no interfaceConfig at all yet and
        // loggingConfig is not loaded but there's a default value in the redux
        // store.
        // Only the config will be overridden on React Native, as the other
        // globals will be undefined here. It's intentional - we do not care
        // to override those configs yet.
        if (config && !error) {
            setConfigFromURLParams(

                // On Web the config also comes from the window.config global,
                // but it is resolved in the load config procedure.
                config,
                window && window.interfaceConfig,
                window && window.loggingConfig,
                newLocation);
        }

        const promise
            = dispatch(setLocationURL(new URL(newLocation.toString())));

        if (error) {
            // XXX The failure could be, for example, because of a
            // certificate-related error. In which case the connection will
            // fail later in Strophe anyway.
            return promise.then(() => {
                dispatch(loadConfigError(error, newLocation));
                throw error;
            });
        }

        const profile = getProfile(getState());

        return promise.then(() => dispatch(setConfig(
            _mergeConfigWithProfile(config, profile)
        )));
    }
}

/**
 * Triggers an in-app navigation to a specific or undefined location (URI).
 *
 * @param {Dispatch} dispatch - The redux {@code dispatch} function.
 * @param {Function} getState - The redux function that gets/retrieves the redux
 * state.
 * @param {Object} location - The location (URI) to navigate to. The value may
 * be undefined.
 * @private
 * @returns {void}
 */
function _appNavigateToOptionalLocation(
        dispatch: Dispatch<*>, getState: Function,
        location: Object) {
    // If the specified location (URI) does not identify a host, use the app's
    // default.
    if (!location || !location.host) {
        const defaultLocation
            = parseURIString(getState()['features/app'].app._getDefaultURL());

        if (location) {
            location.host = defaultLocation.host;

            // FIXME Turn location's host, hostname, and port properties into
            // setters in order to reduce the risks of inconsistent state.
            location.hostname = defaultLocation.hostname;
            location.port = defaultLocation.port;
            location.protocol = defaultLocation.protocol;
        } else {
            // eslint-disable-next-line no-param-reassign
            location = defaultLocation;
        }
    }

    location.protocol || (location.protocol = 'https:');

    return _appNavigateToMandatoryLocation(dispatch, getState, location);
}

/**
 * Signals that a specific App will mount (in the terms of React).
 *
 * @param {App} app - The App which will mount.
 * @returns {{
 *     type: APP_WILL_MOUNT,
 *     app: App
 * }}
 */
export function appWillMount(app: Object) {
    return (dispatch: Dispatch<*>) => {
        dispatch({
            type: APP_WILL_MOUNT,
            app
        });

        // TODO There was a redux action creator appInit which I did not like
        // because we already had the redux action creator appWillMount and,
        // respectively, the redux action APP_WILL_MOUNT. So I set out to remove
        // appInit and managed to move everything it was doing but the
        // following. Which is not extremely bad because we haven't moved the
        // API module into its own feature yet so we're bound to work on that in
        // the future.
        typeof APP === 'object' && APP.API.init();
    };
}

/**
 * Signals that a specific App will unmount (in the terms of React).
 *
 * @param {App} app - The App which will unmount.
 * @returns {{
 *     type: APP_WILL_UNMOUNT,
 *     app: App
 * }}
 */
export function appWillUnmount(app: Object) {
    return {
        type: APP_WILL_UNMOUNT,
        app
    };
}

/**
 * Loads config.js from a specific host.
 *
 * @param {Object} location - The location URI which specifies the host to load
 * the config.js from.
 * @private
 * @returns {Promise<Object>}
 */
function _loadConfig({ contextRoot, host, protocol, room }) {
    // XXX As the mobile/React Native app does not employ config on the
    // WelcomePage, do not download config.js from the deployment when
    // navigating to the WelcomePage - the perceived/visible navigation will be
    // faster.
    if (!room && typeof APP === 'undefined') {
        return Promise.resolve();
    }

    /* eslint-disable no-param-reassign */

    protocol = protocol.toLowerCase();

    // The React Native app supports an app-specific scheme which is sure to not
    // be supported by fetch (or whatever loadConfig utilizes).
    protocol !== 'http:' && protocol !== 'https:' && (protocol = 'https:');

    // TDOO userinfo

    const baseURL = `${protocol}//${host}${contextRoot || '/'}`;
    let url = `${baseURL}config.js`;

    // XXX In order to support multiple shards, tell the room to the deployment.
    room && (url += `?room=${room.toLowerCase()}`);

    /* eslint-enable no-param-reassign */

    const key = `config.js/${baseURL}`;

    return loadConfig(url).then(
        /* onFulfilled */ config => {
            // Try to store the configuration in localStorage. If the deployment
            // specified 'getroom' as a function, for example, it does not make
            // sense to and it will not be stored.
            try {
                if (typeof window.config === 'undefined'
                        || window.config !== config) {
                    window.localStorage.setItem(key, JSON.stringify(config));
                }
            } catch (e) {
                // Ignore the error because the caching is optional.
            }

            return config;
        },
        /* onRejected */ error => {
            // XXX The (down)loading of config failed. Try to use the last
            // successfully fetched for that deployment. It may not match the
            // shard.
            let storage;

            try {
                // XXX Even reading the property localStorage of window may
                // throw an error (which is user agent-specific behavior).
                storage = window.localStorage;

                const config = storage.getItem(key);

                if (config) {
                    return JSON.parse(config);
                }
            } catch (e) {
                // Somehow incorrect data ended up in the storage. Clean it up.
                storage && storage.removeItem(key);
            }

            throw error;
        });
}

/**
 * Merges the downloaded config with the current profile values. The profile
 * values are named the same way as the config values in the config.js so
 * a clean merge is possible.
 *
 * @param {Object|undefined} config - The downloaded config.
 * @param {Object} profile - The persisted profile.
 * @returns {Object}
 */
function _mergeConfigWithProfile(config, profile) {
    if (!config) {
        return;
    }

    return {
        ...config,
        ...profile
    };
}
