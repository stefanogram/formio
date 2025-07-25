'use strict';

// Setup the Form.IO server.//
const fs = require('fs/promises');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const _ = require('lodash');
const events = require('events');
const nunjucks = require('nunjucks');
const log = require('debug')('formio:log');
const gc = require('expose-gc/function');
const {registerEvaluator} = require('@formio/core');

const util = require('./src/util/util');
const {IsolateVMEvaluator} = require('./src/vm');

mongoose.Promise = global.Promise;
const router = express.Router();
// Keep track of the formio interface.
router.formio = {};

// Allow libraries to use a single instance of mongoose.
router.formio.mongoose = mongoose;

// Use custom template delimiters.
_.templateSettings.interpolate = /{{([\s\S]+?)}}/g;

// Allow custom configurations passed to the Form.IO server.
module.exports = function(config) {
  // Give app a reference to our config.
  router.formio.config = config;

  // Add the middleware.
  router.formio.middleware = require('./src/middleware/middleware')(router);

  // Configure nunjucks to not watch any files
  nunjucks.configure([], {
    watch: false
  });

  // Allow events to be triggered.
  router.formio.events = new events.EventEmitter();
  router.formio.config.schema = require('./package.json').schema;

  router.formio.log = (event, req, ...info) => {
    const result = router.formio.hook.alter('log', event, req, ...info);

    if (result) {
      log(event, ...info);
    }
  };

  router.formio.audit = (event, req, ...info) => {
    if (config.audit) {
      const result = router.formio.hook.alter('audit', info, event, req);

      if (result) {
        console.log(...result);
      }
    }
  };

  /**
   * Initialize the formio server.
   */
  router.init = async function(hooks) {
    function setupMemoryLeakPrevention() {
      router.use((req, res, next) => {
        util.Formio.forms = {};
        util.Formio.cache = {};

        try {
          if (config.maxOldSpace) {
            const heap = process.memoryUsage().heapTotal / 1024 / 1024;
            if (config.maxOldSpace * 0.8 < heap) {
              gc();
            }
          }
        }
        catch (error) {
          console.log(error);
        }

        next();
      });
    }

    function setupMiddlewares() {
      if (!router.formio.hook.invoke('init', 'alias', router.formio)) {
        router.use(router.formio.middleware.alias);
      }
      // Establish the parameters.
      if (!router.formio.hook.invoke('init', 'params', router.formio)) {
        router.use(router.formio.middleware.params);
      }
      // Add the db schema sanity check to each request.
      router.use(router.formio.update.sanityCheck);
      // Add Middleware necessary for REST API's
      router.use(bodyParser.urlencoded({extended: true}));
      router.use(bodyParser.json({
        limit: '16mb'
       }));

       // Error handler for malformed JSON
      router.use((err, req, res, next) => {
        if (err instanceof SyntaxError) {
          res.status(400).send(err.message);
        }
        next();
      });

        // CORS Support
        const corsRoute = cors(router.formio.hook.alter('cors'));
        router.use((req, res, next) => {
          if (req.url === '/') {
            return next();
          }

          if (res.headersSent) {
            return next();
          }

          corsRoute(req, res, next);
        });

        // Import our authentication models.
        router.formio.auth = require('./src/authentication/index')(router);

        // Perform token mutation before all requests.
        if (!router.formio.hook.invoke('init', 'token', router.formio)) {
          router.use(router.formio.middleware.tokenHandler);
        }

        // The get token handler
        if (!router.formio.hook.invoke('init', 'getTempToken', router.formio)) {
          router.get('/token', router.formio.auth.tempToken);
        }

        // The current user handler.
        if (!router.formio.hook.invoke('init', 'logout', router.formio)) {
          router.get('/logout', router.formio.auth.logout);
        }

        // The current user handler.
        if (!router.formio.hook.invoke('init', 'current', router.formio)) {
          router.get('/current', router.formio.hook.alter('currentUser', [router.formio.auth.currentUser]));
        }

        // The access handler.
        if (!router.formio.hook.invoke('init', 'access', router.formio)) {
          router.get('/access', router.formio.middleware.accessHandler);
        }

        // The public config handler.
        if (!router.formio.hook.invoke('init', 'config', router.formio)) {
          router.use('/config.json', router.formio.middleware.configHandler);
        }

        // Authorize all urls based on roles and permissions.
        if (!router.formio.hook.invoke('init', 'perms', router.formio)) {
          router.use(router.formio.middleware.permissionHandler);
        }
    }

    async function setupMongoDBConnection() {
      let mongoUrl = config.mongo;
      let mongoConfig = config.mongoConfig ? JSON.parse(config.mongoConfig) : {};
      if (!mongoConfig.hasOwnProperty('connectTimeoutMS')) {
        mongoConfig.connectTimeoutMS = 300000;
      }
      if (!mongoConfig.hasOwnProperty('socketTimeoutMS')) {
        mongoConfig.socketTimeoutMS = 300000;
      }

      if (_.isArray(config.mongo)) {
        mongoUrl = config.mongo.join(',');
      }
      if (config.mongoSA || config.mongoCA) {
        mongoConfig.tls = true;
        mongoConfig.tlsCAFile = config.mongoSA || config.mongoCA;
      }

        if (config.mongoSSL) {
          mongoConfig = {
            ...mongoConfig,
            ...config.mongoSSL,
          };
        }

        // ensure that ObjectIds are serialized as strings, opt out using {transorm: false} when calling
        // toObject() or toJSON() on a document or model. Note that opting out of transform when calling
        // toObject() or toJSON will *also* opt out of any existing plugin transformations, e.g. encryption
        mongoose.ObjectId.set('transform', (val) => val.toString());

        // Connect to MongoDB.
        const connectToMongoDB = async () => {
        try {
          await mongoose.connect(mongoUrl, mongoConfig);
          util.log(' > Mongo connection established.');

          // Load the BaseModel.
          router.formio.BaseModel = require('./src/models/BaseModel');

          // Load the plugins.
          router.formio.plugins = require('./src/plugins/plugins');

          router.formio.schemas = {
            PermissionSchema: require('./src/models/PermissionSchema')(router.formio),
            AccessSchema: require('./src/models/AccessSchema')(router.formio),
            FieldMatchAccessPermissionSchema: require('./src/models/FieldMatchAccessPermissionSchema')(router.formio),
          };

          // Get the models for our project.
          const models = require('./src/models/models')(router);

          // Load the Schemas.
          router.formio.schemas = _.assign(router.formio.schemas, models.schemas);

          // Load the Models.
          router.formio.models = models.models;

          // Load the Resources.
          router.formio.resources = require('./src/resources/resources')(router);

          // Load the request cache
          router.formio.cache = require('./src/cache/cache')(router);

          // Return the form components.
          router.get('/form/:formId/components', async function(req, res, next) {
            try {
              const form = await router.formio.resources.form.model.findOne({_id: req.params.formId});
              if (!form) {
                return res.status(404).send('Form not found');
              }
              // If query params present, filter components that match params
              const filter = Object.keys(req.query).length !== 0 ? _.omit(req.query, ['limit', 'skip']) : null;
              res.json(
                _(util.flattenComponents(form.components))
                .filter(function(component) {
                  if (!filter) {
                    return true;
                  }
                  return _.reduce(filter, function(prev, value, prop) {
                    if (!value) {
                      return prev && _.has(component, prop);
                    }
                    const actualValue = _.property(prop)(component);
                    // loose equality so number values can match
                    return prev && actualValue == value || // eslint-disable-line eqeqeq
                      value === 'true' && actualValue === true ||
                      value === 'false' && actualValue === false;
                  }, true);
                })
                .values()
                .value()
              );
            }
            catch (err) {
              return next(err);
            }
          });

          // Import the form actions.
          router.formio.Action = router.formio.models.action;
          router.formio.actions = require('./src/actions/actions')(router);

          // Add submission data export capabilities.
          require('./src/export/export')(router);

          // Add the available templates.
          router.formio.templates = {
            default: _.cloneDeep(require('./src/templates/default.json'))
          };

          // Add the template functions.
          router.formio.template = require('./src/templates/index')(router);

          const swagger = require('./src/util/swagger');
          // Show the swagger for the whole site.
          router.get('/spec.json', function(req, res, next) {
            swagger(req, router, function(spec) {
              res.json(spec);
            });
          });

          // Show the swagger for specific forms.
          router.get('/form/:formId/spec.json', function(req, res, next) {
            swagger(req, router, function(spec) {
              res.json(spec);
            });
          });

          require('./src/middleware/recaptcha')(router);

          // Say we are done.
          router.formio.db = mongoose.connection;
          return router.formio;
        }
        catch (err) {
          util.log(err.message);
          throw err.message;
        }
        };
        await connectToMongoDB();
    }

    function configureEvaluator() {
        // Configure the evaluator
        const evaluator = new IsolateVMEvaluator({timeoutMs: config.vmTimeout}, router.formio.hook);
        registerEvaluator(evaluator);
    }

    // Hooks system during boot.
    router.formio.hooks = hooks;

    // Add the utils to the formio object.
    router.formio.util = util;

    // Get the hook system.
    router.formio.hook = require('./src/util/hook')(router.formio);

    // Configure Formio, if applicaple.
    router.formio.hook.alter('configFormio', {Formio: util.Formio});

    // Get the encryption system.
    router.formio.encrypt = require('./src/util/encrypt');

    // Load the updates and attach them to the router.
    router.formio.update = require('./src/db/index')(router.formio);
    // Run the healthCheck sanity check on /health
    /* eslint-disable max-statements */
    const db = await router.formio.update.initialize();
    util.log('Initializing API Server.');
    // Add the database connection to the router.
    router.formio.db = db;

    setupMemoryLeakPrevention();
    setupMiddlewares();
    configureEvaluator();
    await setupMongoDBConnection();

    return router.formio;
  };

  return router;
};
