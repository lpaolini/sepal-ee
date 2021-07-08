const {toGeometry} = require('../aoi')
const {of} = require('rxjs')
const _ = require('lodash')
const ee = require('ee')

const timeSeries = recipe => {
    const geometry = toGeometry(recipe.model.aoi)
    return {
        getImage$() {
            return of(ee.Image())
        },

        getVisParams$(_image) {
            throw new Error('Time-series cannot be visualized directly.')
        },

        getGeometry$() {
            return of(geometry)
        }
    }
}

module.exports = timeSeries
