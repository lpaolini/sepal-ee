const {requireOnce} = require('@sepal/utils')

module.exports = requireOnce('@google/earthengine', ee =>
    require('./extensions')(ee)
)
