'use strict';

const Bluebird = require('bluebird');
const Boom = require('boom');
const Crypto = require('crypto');
const _ = require('lodash');


exports.register = register;
exports.register.attributes = {
    name: 'healthz',
    version: '1.0.0',
    dependencies: [
        'cache',
        'previews',
        'redis',
        'renderer',
    ],
};


function register(server, options, next) {
    server.log(['info', 'init'], `Started ${exports.register.attributes.name}@${exports.register.attributes.version}.`);

    server.route({
        method: 'GET',
        path: '/healthz',
        handler: handleHealthz,
    });

    next();
}

function handleHealthz(request, reply) {
    const server = request.server;
    const data = Bluebird.props({
        preview: runPreview(server),
        redis: pingRedis(server),
    });

    return data
        .then(parseHealthData)
        .then(data => {
            return reply(data)
                .code(data.statusCode);
        }, reply);
}

function parseHealthData(health) {
    const statusCode = _.find(health, _.matches({ status: 'ERROR' }))
        ?   500
        :   200;

    return { health, statusCode };
}

function pingRedis(server) {
    const client = server.plugins.redis.client;
    const start = Date.now();
    const ping = Bluebird.promisify(client.ping, { context: client });

    return ping()
        .then((response) => {
            if (response !== 'PONG') {
                throw Boom.serverUnavailable('Invalid response from redis ping:' + response);
            }

            return {
                response,
                latency: Date.now() - start,
                status: 'OK',
            };
        })
        .catch((error) => {
            server.log(['error', 'healthz', 'redis'], {
                error: error.message,
                error_code: error.code,
                message: 'Redis health check failed',
            });

            return {
                latency: Date.now() - start,
                status: 'ERROR',
            };
        });
}

function runPreview(server) {
    const start = Date.now();
    const previewId = Crypto.randomBytes(16).toString('hex');
    const preview = {
        files: {
            'index.html': {
                content: previewId,
                encoding: 'utf-8',
            },
        },
    };

    return createPreview()
        .tap(verifyPreviewUpsertResponse)
        .then(requestPreview)
        .tap(verifyPreviewGetResponse)
        .then(mapToHealthz)
        .catch((error) => {
            server.log(['error', 'healthz', 'preview'], {
                error: error.message,
                error_code: error.code,
                message: 'Preview health check failed',
            });

            return {
                latency: Date.now() - start,
                status: 'ERROR',
            };
        });


    function createPreview() {
        return Bluebird.resolve(server.inject({
            method: 'POST',
            url: `/preview/${previewId}`,
            payload: preview,
        }));
    }

    function verifyPreviewUpsertResponse(res) {
        if (res.statusCode !== 302) {
            throw Boom.badGateway('Preview creation response has an unexpected status code: ' + res.statusCode);
        }
        if (res.headers.location !== `/preview/${previewId}`) {
            throw Boom.badGateway('Preview creation response has an unexpected location: ' + res.headers.location);
        }
    }

    function requestPreview() {
        return server.inject({
            method: 'GET',
            url: `/preview/${previewId}/`,
        });
    }

    function verifyPreviewGetResponse(res) {
        if (res.statusCode !== 200) {
            throw Boom.badGateway('Preview creation response has an unexpected status code: ' + res.statusCode);
        }
        if (res.payload.toString('utf8') !== preview.files['index.html'].content) {
            server.log(['error', 'healthz', 'preview'], {
                actual: res.payload.toString('utf8'),
                expected: preview.files['index.html'].content,
                message: 'Preview creation response has an unexpected payload',
            });

            throw Boom.badGateway('Preview creation response has an unexpected payload: ' + res.payload.toString('utf8'));
        }
    }

    function mapToHealthz(response) {
        const payload = response.payload.toString('utf8');

        return {
            payload,
            latency: Date.now() - start,
            status: 'OK',
        };
    }
}
