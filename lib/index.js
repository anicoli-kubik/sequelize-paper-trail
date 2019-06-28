import Sequelize from 'sequelize';
import jsdiff from 'diff';
import _ from 'lodash';
import helpers from './helpers';

let failHard = false;

exports.init = (sequelize, optionsArg) => {
  // In case that options is being parsed as a readonly attribute.
  // Or it is not passed at all
  const optsArg = _.cloneDeep(optionsArg || {});

  const defaultOptions = {
    debug: false,
    log: null,
    exclude: [
      'id',
      'createdAt',
      'updatedAt',
      'deletedAt',
      'created_at',
      'updated_at',
      'deleted_at',
      'revision',
    ],
    revisionAttribute: 'revision',
    revisionModel: 'Revision',
    revisionChangeModel: 'RevisionChange',
    enableRevisionChangeModel: false,
    underscored: false,
    underscoredAttributes: false,
    defaultAttributes: {
      documentId: 'documentId',
      revisionId: 'revisionId',
    },
    getUserId: () => { },
    enableCompression: false,
    enableMigration: false,
    enableStrictDiff: true,
    mysql: false,
  };

  if (optsArg.underscoredAttributes) {
    helpers.toUnderscored(defaultOptions.defaultAttributes);
  }

  const options = _.defaults(optsArg, defaultOptions);

  const log = options.log || console.log;

  function createBeforeHook(operation) {
    const beforeHook = function beforeHook(instance, opt) {
      if (options.debug) {
        log('beforeHook called');
        log('instance:', instance);
        log('opt:', opt);
      }

      const destroyOperation = operation === 'destroy';

      let previousVersion = {};
      let currentVersion = {};
      if (!destroyOperation && options.enableCompression) {
        _.forEach(opt.defaultFields, a => {
          previousVersion[a] = instance._previousDataValues[a];
          currentVersion[a] = instance.dataValues[a];
        });
      } else {
        previousVersion = instance._previousDataValues;
        currentVersion = instance.dataValues;
      }
      // Supported nested models.
      previousVersion = _.omitBy(
        previousVersion,
        i => i != null && typeof i === 'object' && !(i instanceof Date),
      );
      previousVersion = _.omit(previousVersion, options.exclude);

      currentVersion = _.omitBy(
        currentVersion,
        i => i != null && typeof i === 'object' && !(i instanceof Date),
      );
      currentVersion = _.omit(currentVersion, options.exclude);

      // Disallow change of revision
      instance.set(
        options.revisionAttribute,
        instance._previousDataValues[options.revisionAttribute],
      );

      // Get diffs
      const delta = helpers.calcDelta(
        previousVersion,
        currentVersion,
        options.exclude,
        options.enableStrictDiff,
      );

      const currentRevisionId = instance.get(options.revisionAttribute);

      if (failHard && !currentRevisionId && opt.type === 'UPDATE') {
        throw new Error('Revision Id was undefined');
      }

      if (options.debug) {
        log('delta:', delta);
        log('revisionId', currentRevisionId);
      }

      if (destroyOperation || (delta && delta.length > 0)) {
        const revisionId = (currentRevisionId || 0) + 1;
        instance.set(options.revisionAttribute, revisionId);

        if (!instance.context) {
          instance.context = {};
        }
        instance.context.delta = delta;
      }

      if (options.debug) {
        log('end of beforeHook');
      }
    };
    return beforeHook;
  }

  function createAfterHook(operation) {
    const afterHook = function afterHook(instance, opt) {
      if (options.debug) {
        log('afterHook called');
        log('instance:', instance);
        log('opt:', opt);
      }

      const destroyOperation = operation === 'destroy';

      if (
        instance.context &&
        ((instance.context.delta &&
          instance.context.delta.length > 0) ||
          destroyOperation)
      ) {
        const Revision = sequelize.model(options.revisionModel);
        let RevisionChange;

        if (options.enableRevisionChangeModel) {
          RevisionChange = sequelize.model(
            options.revisionChangeModel,
          );
        }

        const { delta } = instance.context;

        let previousVersion = {};
        let currentVersion = {};
        if (!destroyOperation && options.enableCompression) {
          _.forEach(opt.defaultFields, a => {
            previousVersion[a] = instance._previousDataValues[a];
            currentVersion[a] = instance.dataValues[a];
          });
        } else {
          previousVersion = instance._previousDataValues;
          currentVersion = instance.dataValues;
        }

        // Supported nested models.
        previousVersion = _.omitBy(
          previousVersion,
          i => i != null &&
            typeof i === 'object' &&
            !(i instanceof Date),
        );
        previousVersion = _.omit(previousVersion, options.exclude);

        currentVersion = _.omitBy(
          currentVersion,
          i => i != null &&
            typeof i === 'object' &&
            !(i instanceof Date),
        );
        currentVersion = _.omit(currentVersion, options.exclude);

        if (failHard && !global.userId) {
          throw new Error(
            `The CLS continuationKey ${
              options.continuationKey
            } was not defined.`,
          );
        }

        let document = currentVersion;

        if (options.mysql) {
          document = JSON.stringify(document);
        }

        // Build revision
        const query = {
          model: this.name,
          document,
          operation,
        };

        // in case of custom user models that are not 'userId'
        query.userId = options.getUserId() || opt.userId;

        query[
          options.defaultAttributes.documentId
        ] = instance.id.toString();

        const revision = Revision.build(query);

        revision[options.revisionAttribute] = instance.get(
          options.revisionAttribute,
        );

        return revision
          .save({ transaction: opt.transaction })
          .then(rev => {
            if (options.enableRevisionChangeModel) {
              _.forEach(delta, difference => {
                const o = helpers.diffToString(
                  difference.item
                    ? difference.item.lhs
                    : difference.lhs,
                );
                const n = helpers.diffToString(
                  difference.item
                    ? difference.item.rhs
                    : difference.rhs,
                );

                document = difference;
                let diff = o || n ? jsdiff.diffChars(o, n) : [];

                if (options.mysql) {
                  document = JSON.stringify(document);
                  diff = JSON.stringify(diff);
                }

                const d = RevisionChange.build({
                  path: difference.path[0],
                  document,
                  diff,
                });

                d.save({ transaction: opt.transaction })
                  .then(di => {
                    rev[
                      `add${helpers.capitalizeFirstLetter(
                        options.revisionChangeModel,
                      )}`
                    ](di);
                  })
                  .catch(err => {
                    log('RevisionChange save error', err);
                    throw err;
                  });
              });
            }
          })
          .catch(err => {
            log('Revision save error', err);
            throw err;
          });
      }

      if (options.debug) {
        log('end of afterHook');
      }

      return null;
    };
    return afterHook;
  }

  _.assignIn(Sequelize.Model, {
    hasPaperTrail: function hasPaperTrail() {
      if (options.debug) {
        log('Enabling paper trail on', this.name);
      }

      this.rawAttributes[options.revisionAttribute] = {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      };
      this.revisionable = true;

      this.refreshAttributes();

      if (options.enableMigration) {
        const tableName = this.getTableName();

        const queryInterface = sequelize.getQueryInterface();

        queryInterface.describeTable(tableName).then(attributes => {
          if (!attributes[options.revisionAttribute]) {
            if (options.debug) {
              log('adding revision attribute to the database');
            }

            queryInterface
              .addColumn(tableName, options.revisionAttribute, {
                type: Sequelize.INTEGER,
                defaultValue: 0,
              })
              .catch(err => {
                log('something went really wrong..', err);
              });
          }
        });
      }

      this.addHook('beforeCreate', createBeforeHook('create'));
      this.addHook('beforeDestroy', createBeforeHook('destroy'));
      this.addHook('beforeUpdate', createBeforeHook('update'));
      this.addHook('afterCreate', createAfterHook('create'));
      this.addHook('afterDestroy', createAfterHook('destroy'));
      this.addHook('afterUpdate', createAfterHook('update'));
    },
  });

  return {
    // Return defineModels()
    defineModels: function defineModels(db) {
      // Attributes for RevisionModel
      let attributes = {
        model: {
          type: Sequelize.TEXT,
          allowNull: false,
        },
        document: {
          type: Sequelize.JSON,
          allowNull: false,
        },
        operation: Sequelize.STRING(7),
        userId: Sequelize.STRING,
      };

      if (options.mysql) {
        attributes.document.type = Sequelize.TEXT('MEDIUMTEXT');
      }

      attributes[options.defaultAttributes.documentId] = {
        type: Sequelize.STRING,
        allowNull: false,
      };

      attributes[options.revisionAttribute] = {
        type: Sequelize.INTEGER,
        allowNull: false,
      };

      if (options.debug) {
        log('attributes', attributes);
      }

      // Revision model
      const Revision = sequelize.define(
        options.revisionModel,
        attributes,
        {
          underscored: options.underscored,
        },
      );
      Revision.associate = function associate(models) {
        log('models', models);

        // Revision.belongsTo(sequelize.model(options.userModel));
      };

      if (options.enableRevisionChangeModel) {
        // Attributes for RevisionChangeModel
        attributes = {
          path: {
            type: Sequelize.TEXT,
            allowNull: false,
          },
          document: {
            type: Sequelize.JSON,
            allowNull: false,
          },
          diff: {
            type: Sequelize.JSON,
            allowNull: false,
          },
        };

        if (options.mysql) {
          attributes.document.type = Sequelize.TEXT('MEDIUMTEXT');
          attributes.diff.type = Sequelize.TEXT('MEDIUMTEXT');
        }

        // RevisionChange model
        const RevisionChange = sequelize.define(
          options.revisionChangeModel,
          attributes,
          {
            underscored: options.underscored,
          },
        );

        // Set associations
        Revision.hasMany(RevisionChange, {
          foreignKey: options.defaultAttributes.revisionId,
          constraints: false,
        });

        RevisionChange.belongsTo(Revision);

        if (db) db[RevisionChange.name] = RevisionChange;
      }

      if (db) db[Revision.name] = Revision;

      return Revision;
    },
  };
};

/**
 * Throw exceptions when the user identifier from CLS is not set or if the
 * revisionAttribute was not loaded on the model.
 */
exports.enableFailHard = () => {
  failHard = true;
};

module.exports = exports;
