const ee = require('ee')
const _ = require('lodash')
const moment = require('moment')
const dataSetSpecs = require('./dataSetSpecs')
const imageProcess = require('./imageProcess')
const maskClouds = require('./maskClouds')
const maskShadows = require('./maskShadows')
const applyPercentileFilter = require('./applyPercentileFilter')
const {compose} = require('../functional')

const allScenes = (
    {
        geometry,
        dates: {
            targetDate,
            seasonStart,
            seasonEnd,
            yearsBefore = 0,
            yearsAfter = 0
        } = {},
        dataSets,
        reflectance = 'TOA',
        calibrate,
        brdfCorrect,
        cloudDetection,
        cloudMasking,
        cloudBuffer,
        shadowMasking = 'OFF',
        snowMasking,
        filters,
        panSharpen
    }) => {
    const filter = ee.Filter.and(
        ee.Filter.bounds(geometry),
        dateFilter({seasonStart, seasonEnd, yearsBefore, yearsAfter})
    )

    const collection = dataSets.reduce((mergedCollection, dataSet) =>
        mergeImageCollections(
            mergedCollection,
            createCollection({dataSet, reflectance, filter})
        ),
    ee.ImageCollection([])
    )
    return processCollection({
        dataSets,
        collection,
        reflectance,
        calibrate,
        brdfCorrect,
        filters,
        cloudDetection,
        cloudMasking,
        cloudBuffer,
        shadowMasking,
        snowMasking,
        panSharpen,
        targetDate
    })
}

const dateFilter = ({seasonStart, seasonEnd, yearsBefore, yearsAfter}) => {
    const dateFormat = 'YYYY-MM-DD'
    const filter = yearDelta =>
        ee.Filter.date(
            moment(seasonStart).add(yearDelta, 'years').format(dateFormat),
            moment(seasonEnd).add(yearDelta, 'years').format(dateFormat)
        )

    return ee.Filter.or(...[
        filter(0),
        _.range(0, yearsBefore).map(i => filter(i - 1)),
        _.range(0, yearsAfter).map(i => filter(i + 1))
    ].flat())
}

const selectedScenes = (
    {
        reflectance,
        calibrate,
        brdfCorrect,
        filters,
        cloudDetection,
        cloudMasking,
        cloudBuffer,
        shadowMasking = 'OFF',
        snowMasking,
        panSharpen,
        targetDate,
        scenes
    }) => {
    const scenesByDataSet = _.chain(scenes)
        .flatten()
        .groupBy('dataSet')
        .value()
    const dataSets = Object.keys(scenesByDataSet)
    const collection = _.chain(scenesByDataSet)
        .mapValues(scenes =>
            scenes.map(scene => toEEId(scene))
        )
        .mapValues((ids, dataSet) =>
            createCollectionWithScenes({dataSet, reflectance, ids})
        )
        .values()
        .reduce(
            (acc, collection) => mergeImageCollections(acc, collection),
            ee.ImageCollection([])
        )
        .value()

    return processCollection({
        dataSets,
        collection,
        reflectance,
        calibrate,
        brdfCorrect,
        filters,
        cloudDetection,
        cloudMasking,
        cloudBuffer,
        shadowMasking,
        snowMasking,
        panSharpen,
        targetDate
    })
}

const createCollectionWithScenes = ({dataSet, reflectance, ids}) => {
    const filter = ee.Filter.inList('system:index', ids)
    return createCollection({dataSet, reflectance, filter})
}

const createCollection = ({dataSet, reflectance, filter}) => {
    const dataSetSpec = dataSetSpecs[reflectance][dataSet]
    const collection = ee.ImageCollection(dataSetSpec.collectionName)
        .filter(filter)
        .map(image => image.set('dataSetSpec', dataSetSpec))
    if (dataSet === 'SENTINEL_2') {
        const clouds = ee.ImageCollection('COPERNICUS/S2_CLOUD_PROBABILITY')
            .filter(filter)
        return ee.ImageCollection(
            ee.Join.saveFirst('cloudProbability').apply({
                primary: collection,
                secondary: clouds,
                condition:
                    ee.Filter.equals({leftField: 'system:index', rightField: 'system:index'})
            })
        )
    } else {
        return collection
    }
}

const processCollection = (
    {
        dataSets,
        collection,
        reflectance,
        calibrate,
        brdfCorrect,
        filters,
        cloudDetection,
        cloudMasking,
        cloudBuffer,
        shadowMasking,
        snowMasking,
        panSharpen,
        targetDate
    }) => {
    const bands = findCommonBands(dataSets, reflectance)
    const mappedCollection = collection
        .map(imageProcess({
            bands,
            calibrate,
            brdfCorrect,
            cloudDetection,
            cloudMasking,
            cloudBuffer,
            reflectance,
            snowMasking,
            panSharpen,
            targetDate
        }))
    return compose(
        mappedCollection,
        shadowMasking !== 'OFF' && maskShadows(),
        // If cloudMasking isn't turned off, clouds are masked when processing individual images.
        // When it is turned off, only mask clouds when there is at least one cloud-free pixel
        cloudMasking === 'OFF' && maskClouds(),
        ...filters.map(applyFilter)
    ).select(bands)
}

const findCommonBands = (dataSets, reflectance) => {
    const allBands = dataSets
        .map(dataSetName => dataSetSpecs[reflectance][dataSetName])
        .map(dataSet => Object.keys(dataSet.bands))
    const dateBands = ['unixTimeDays', 'dayOfYear', 'daysFromTarget', 'targetDayCloseness']
    return [..._.intersection(...allBands), ...dateBands]
}

const bandByFilter = {
    SHADOW: 'shadowScore',
    HAZE: 'hazeScore',
    NDVI: 'ndvi',
    DAY_OF_YEAR: 'targetDayCloseness'
}

const applyFilter = filter =>
    applyPercentileFilter(bandByFilter[filter.type], filter.percentile)

const toEEId = ({id, dataSet, date}) =>
    dataSet === 'SENTINEL_2'
        ? id
        : toEELandsatId({id, date})

const toEELandsatId = ({id, date}) =>
    [
        id.substring(0, 2),
        '0',
        id.substring(2, 3),
        '_',
        id.substring(3, 9),
        '_',
        moment(date, 'YYYY-MM-DD').format('YYYYMMDD')
    ].join('')

const mergeImageCollections = (c1, c2) =>
    ee.ImageCollection(c1.merge(c2))

const hasImagery = ({dataSets, reflectance, geometry, startDate, endDate}) =>
    dataSets
        .map(dataSet =>
            ee.ImageCollection(dataSetSpecs[reflectance][dataSet].collectionName)
                .filterDate(startDate, endDate)
                .filterBounds(geometry)
        )
        .reduce(mergeImageCollections, ee.ImageCollection([]))
        .isEmpty()
        .not()

module.exports = {allScenes, selectedScenes, hasImagery, findCommonBands}
