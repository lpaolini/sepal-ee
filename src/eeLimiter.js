const {Limiter} = require('@sepal/service')

module.exports = Limiter({
    name: 'EE',
    rateWindowMs: 1000,
    maxRate: 10,
    maxConcurrency: 20
})
