import chalk from 'chalk';
import * as Joi from 'joi';
import * as ora from 'ora';
import axios from 'axios';
import * as qs from 'qs';
import * as faker from 'faker';
import { colorizeMain, colorizeCustomRed } from './handler';
import { requestsObjectSchema as requestObjectSchema } from './configSchema';
import { config } from './configLoader';
import * as jp from 'jsonpath';
import * as nunjucks from 'nunjucks';
import * as yaml from 'js-yaml';

require('request-to-curl');

nunjucks.configure( { tags: {
  blockStart: '<%',
  blockEnd: '%>',
  variableStart: '<$',
  variableEnd: '$>',
  commentStart: '<#',
  commentEnd: '#>'
}})

const nunjucksEnv = new nunjucks.Environment();

nunjucksEnv.addGlobal('Faker', function(faked: string) {
  return faker.fake(`{{${faked}}}`);
})

nunjucksEnv.addGlobal('Env', function(envi: string) {
  let environ = process.env[envi]
  return environ;
})

/**
 * All Data that any request returns, will be stored here. After that it can be used in the following methods
 */
let requestReponses: any = {
  // // Example data
  // register: {
  //     id: 123,
  //     token: 'aTokenValue'
  // },
  // rawDataExample: 'asdaasds'
}

// The manually defined variables 
// Usable throught Variable(variableName) or Var(variableName)
let definedVariables: any = {

}

/**
 * Main handler that will perform the tests with each valid test object
 * @param testObjects 
 * @param printAll If true, all response information will be logged in the console
 */
export const performTests = async (testObjects: object[], cmd: any) => {
  let testObject: any
  let abortBecauseTestFailed = false;
  
  const printAll = cmd.print;

  // true if the --output curl option was set
  const toCurl = cmd.output == 'curl';
  let curPath = "./";
  if(testObjects.length > 1){
    console.log(chalk.blueBright("Executing tests in " + curPath));
  }
  for(testObject of testObjects){
  
    if(testObject['allowInsecure']) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }

    if(testObject['variables']) {
      // merge the existing variables with the new to allow multiple testfiles
      // to use variables from previous files
      definedVariables = {
        ...definedVariables,
        ...testObject['variables']
      }
    }
  
    if (curPath != testObject.relativePath && testObjects.length > 1){
      console.log(chalk.blueBright("Executing tests in: " + testObject.relativePath));
    }
    curPath = testObject.relativePath
    if(!abortBecauseTestFailed){
    
      const requests = testObject['requests'];
      for(let requestName in requests) {
    
        if(!abortBecauseTestFailed) {
          const val = requests[requestName];

          let runTimes = 1;
          if(typeof val.validate !== 'undefined'){
            if(typeof val.validate.max_retries !== 'undefined'){
              runTimes = val.validate.max_retries;
            }
          }
          for(let i = 0; i != runTimes; i++) {
            // Delay for the specified number of milliseconds if given
            if(typeof val.delay !== 'undefined') {
              const waitSpinner = ora(`Waiting for ${chalk.bold(colorizeMain(val.delay))} milliseconds`).start();

              await function() {
                return new Promise(resolve => setTimeout(resolve, val.delay));
              }();

              waitSpinner.stop();
            }

            const spinner = ora(`Testing ${chalk.bold(colorizeMain(requestName))}`).start();
            const startTime = new Date().getTime();
            let result = "succeeded"
            let error = null
            let computed = computeRequestObject(requestName, testObject.raw, requestReponses);
            if(error !== null) {
              // pass
            } else {
              if(typeof computed.if !== 'undefined'){
                if(computed.if.operand == computed.if.equals){
                  error = await performRequest(computed, requestName, printAll);
                } else {
                  result = "skipped"
                  error = { isError: false, message: null, har: null, code: 0 }
                }
              } else {
                error = await performRequest(computed, requestName, printAll);
              }
            }

            const endTime = new Date().getTime();
            const execTime = (endTime - startTime) / 1000;

            if(error.isError === true) {
              if(runTimes === 1){
                spinner.clear();
                spinner.fail(colorizeCustomRed(`Testing ${chalk.bold(colorizeCustomRed(requestName))} failed (${chalk.bold(`${execTime.toString()}s`)}) \n${error.message}\n`))
                if(!cmd.noExit) {
                  return 1;
                } 
              } else {
                if(runTimes - 1 === i){
                  spinner.fail(colorizeCustomRed(`Testing ${chalk.bold(colorizeCustomRed(requestName))} failed to validate within ${chalk.bold(colorizeCustomRed(runTimes.toString()))} (${chalk.bold(`${execTime.toString()}s`)}) \n${error.message}\n`))
                  abortBecauseTestFailed = true;
                  if(!cmd.noExit) {
                    return 1;
                  }
                } else {
                  spinner.fail(colorizeCustomRed(`Testing ${chalk.bold(colorizeCustomRed(requestName))} failed to validate. Retrying (${chalk.bold((runTimes -i).toString())})... (${chalk.bold(`${execTime.toString()}s`)}) \n${error.message}\n`))
                  continue
                }
              }
            } else {
              let har = error.har
              if(har) {
                // log the response info and data
                // let parsedData = JSON.stringify(error.har, null, 2);
                let dataString = '';
                if('content' in har) {
                  dataString = `\n\n${colorizeMain('Content')}: \n\n${chalk.hex(config.secondaryColor)(JSON.stringify(har.content))}\n`;
                } else {
                  dataString = `\n\n${colorizeMain('Content')}: No Content received\n`;
                }
                if ('status')
                spinner.succeed(
                  `Testing ${chalk.bold(colorizeMain(requestName))} ${result} (${chalk.bold(`${execTime.toString()}s`)})` +
                  `\n\n${colorizeMain('Status')}: ${har.status}`+
                  `\n${colorizeMain('Status Text')}: ${har.statusText}` +
                  `\n\n${colorizeMain('Headers')}: \n\n${chalk.hex(config.secondaryColor)(JSON.stringify(har.headers, null ,2))}` +
                  `${dataString}`
                )
              } else {
                spinner.succeed(`Skipped ${chalk.bold(colorizeMain(requestName))} (${chalk.bold(`${execTime.toString()}s`)})`)
              }
            }
            if(toCurl === true){
              console.log(`\n${colorizeMain('Curl Equivalent: ')}${chalk.grey(error.curl)}\n`);
            }
            break
          }
        }
      }
    }
  }
  return 0;
} 

/**
 * Use nunjucks to replace and update the object
 * @param obj working obj
 */
export const computeRequestObject = (requestName: string, raw: string, r: any) => {

  let merged = {...r, ...definedVariables};

  nunjucksEnv.addGlobal('JsonPath', function(path: string) {
    return jp.value(r, path)
  })

  // Parse obj using nunjucks
  try {
    let converted = nunjucksEnv.renderString(raw, merged)
    const parsed: any = yaml.safeLoad(converted)
    return parsed.requests[requestName]
  } catch(e) {
    throw e;
  }
}

/**
 * Print out a formatted Validation error
 */
const validationError = (message: string) => {
  return `[ Validation ] ${message}`
}

/**
 * Checks whether a type matches the dataToProof
 * @param type 
 * @param dataToProof 
 */
export const validateType = (type: string, dataToProof: any) => {  
  
  switch(type) {
    // strings
    case "string":
      return Joi.validate(dataToProof, Joi.string()).error === null
    case "string.hex":
      return Joi.validate(dataToProof, Joi.string().hex()).error === null
    case "string.email":
      return Joi.validate(dataToProof, Joi.string().email()).error === null
    case "string.ip":
      return Joi.validate(dataToProof, Joi.string().ip()).error === null
    case "string.url":
    case "string.uri":
      return Joi.validate(dataToProof, Joi.string().uri()).error === null
    case "string.lowercase":
      return Joi.validate(dataToProof, Joi.string().lowercase()).error === null
    case "string.uppercase":
      return Joi.validate(dataToProof, Joi.string().uppercase()).error === null
    case "string.base64":
      return Joi.validate(dataToProof, Joi.string().base64()).error === null
    // boolean
    case "bool":
    case "boolean":
      return Joi.validate(dataToProof, Joi.boolean()).error === null
    // object
    case "object":
      return Joi.validate(dataToProof, Joi.object()).error === null
    // array
    case "array":
      return Joi.validate(dataToProof, Joi.array()).error === null
    // number
    case "number":
      return Joi.validate(dataToProof, Joi.number()).error === null
    case "number.positive":
      return Joi.validate(dataToProof, Joi.number().positive()).error === null
    case "number.negative":
      return Joi.validate(dataToProof, Joi.number().negative()).error === null
    case "null":
      return Joi.validate(dataToProof, Joi.allow(null)).error === null
    default: 
      return undefined;
  };
} 

/**
 * Perform the Request
 * @param requestObject All config data
 * @param requestName Name of the request
 * @param printAll If true, all response information will be logged in the console
 */
const performRequest = async (requestObject: requestObjectSchema, requestName: string, printAll: boolean) => {

  // parse the requestObject
  // let requestMethod: string, requestData: any, requestUrl: string, requestHeaders: any, requestParams: string;
  interface AxiosObject {
    url?: any,
    method?: any,
    data?: any,
    params?: any,
    headers?: any,
    validateStatus?: any
  }

  let axiosObject: AxiosObject = {};
  // optional keys 
  axiosObject.url = requestObject.request.url;
  axiosObject.method = requestObject.request.method;

  // headers 
  if(typeof requestObject.request.headers !== 'undefined') {
    axiosObject.headers = requestObject.request.headers;
  }

  if(typeof requestObject.auth !== 'undefined') {
    if(typeof requestObject.auth.basic !== 'undefined') {
      const username = requestObject.auth.basic.username;
      const password = requestObject.auth.basic.password;

      const encoded = Buffer.from(username + ':' + password).toString('base64');
      if(typeof axiosObject.headers === 'undefined') {
        axiosObject.headers = {Authorization:null}
      }
      axiosObject.headers.Authorization = `Basic ${encoded}`;
    }
  }

  // queryString
  for(let query in requestObject.request.queryString){
    axiosObject.url += '?' + qs.stringify(query.toString())
  }
  // if(typeof requestObject.request.queryString !== 'undefined') {
  //   // stringify queryString
  //   console.log(requestObject.request.queryString)
  //   axiosObject.url += '?' + qs.stringify(requestObject.request.queryString)
  // }
  // data
  if(typeof requestObject.request.postData !== 'undefined') {
    // json data
    if(requestObject.request.postData.params) {
      axiosObject.data = requestObject.request.postData.params;
    }
    // text data
    if(requestObject.request.postData.text) {
      axiosObject.data = requestObject.request.postData.text;
    }
  }

  try {
    let axiosInstance = axios.create({
      validateStatus: function (status) {
        return status < 500; // Reject only if the status code is greater than or equal to 500
      }
    })
    let response = await axiosInstance(axiosObject)

    if(typeof response.data !== 'undefined') {
      requestReponses[requestName] = response.data;
    }

    const req = response.request;
    // Convert req to har object structure

    const har = {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      content: response.data
    }
    let message = ""
    for (let validate of requestObject.validate){
      let jsonPathValue = jp.value(har, validate.jsonpath)
      if (validate.expect){
        if(jsonPathValue !== validate.expect){
          let err = validationError(`The JSON response value should have been ${chalk.bold(validate.expect)} but instead it was ${chalk.bold(jsonPathValue)}`);
          return { isError: true, har: har, message: err, code: 1 }
        }else{
          message = message + "jsonpath " + validate.jsonpath + "(" +jsonPathValue + ")" + " equals " + validate.expect + "\n"
        }
      }
      if (validate.type){
        let validated = validateType(validate.type, jsonPathValue)
        if (validated){
          let err = validationError(`The Type should have been ${chalk.bold(validate.type)} but instead it was ${chalk.bold(jsonPathValue)}`);
          return { isError: true, har: har, message: err, code: 1 }
        }else{
          message = message + "jsonpath " + validate.jsonpath + "(" +jsonPathValue + ")" + " type equals " + validate.type + "\n"
        }
      }
    }

    // if the result should be logged
    if(requestObject.log === true || requestObject.log == 'true' || printAll === true) {
      return { isError: false, har: har, message: message, code: 0, curl: req.toCurl() }
    }
    return { isError: false, har: null, message: message, code: 0, curl: req.toCurl() }
  } catch(e) {
    return { isError: true, har: null, message: e, code: 1 }
  }
}
