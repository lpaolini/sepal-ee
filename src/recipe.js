const {context} = require('@sepal/utils')
const {map} = require('rxjs/operators')
const http = require('@sepal/http-client')

const loadRecipe$ = id =>
    http.get$(`https://${context().sepalHost}/api/processing-recipes/${id}`, {
        username: context().sepalUsername,
        password: context().sepalPassword
    }).pipe(
        map(response => JSON.parse(response.body))
    )

module.exports = {loadRecipe$}
