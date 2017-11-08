///////////////////////////////////////////////////////////////////////////
// Copyright 2016 Esri. All Rights Reserved.
//
// Licensed under the Apache License Version 2.0 (the 'License');
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an 'AS IS' BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
///////////////////////////////////////////////////////////////////////////
define(['dojo/_base/declare',
    'dojo/_base/array',
    'dojo/_base/lang',
    'dojo/_base/html',
    'dojo/query',
    'dojo/on',
    'dojo/Deferred',
    'dojo/DeferredList',
    'dojo/Evented',
    'dojox/data/CsvStore',
    'dojo/store/Observable',
    'dojo/store/Memory',
    'esri/graphicsUtils',
    'esri/geometry/webMercatorUtils',
    'esri/geometry/Point',
    'esri/Color',
    'esri/symbols/SimpleMarkerSymbol',
    'esri/renderers/SimpleRenderer',
    'esri/layers/FeatureLayer',
    'esri/tasks/locator',
    'esri/tasks/query',
    'jimu/utils',
    './GeocodeCacheManager'
],
function (declare, array, lang, html, query, on, Deferred, DeferredList, Evented, CsvStore, Observable, Memory,
  graphicsUtils, webMercatorUtils, Point, Color, SimpleMarkerSymbol, SimpleRenderer, FeatureLayer, Locator, Query,
  jimuUtils, GeocodeCacheManager) {
  return declare([Evented], {

    //may just move away from the this.useMultiFields alltogether since each source should know what it supports
    //but each source can use either actually...need to really think through this
    //so if they flag single and multi on a single locator...that locator should actually be processed twice
    //once for multi and once for single is what I am thinking 

    //TODO may move all geocode logic into GeocodeCacheManager if we go with supporting that
    // Main doubt with the cache idea is for proper handeling if the locations provided by the world geocoder change
    // would basically need to test each address in the cahce individually to avoid additional credit consumption. This could be way too chatty
    // could make it's use optional also


    //TODO move away from cache manager...add function to search for duplicates in the service
    // need to understand how we know what fields from the service should be compared with search layers
    file: null,
    map: null,
    spatialReference: null,
    fsFields: [],
    duplicateTestFields: [], //field names from the layer
    geocodeSources: [],
    duplicateData: [],
    data: null,
    editLayer: null,
    separatorCharacter: null,
    csvStore: null,
    storeItems: null,
    matchedFeatureLayer: null,
    mappedArrayFields: null,
    unMatchedFeatureLayer: null,
    duplicateFeatureLayer: null,
    addrFieldName: "", //double check but I don't think this is necessary anymore
    xFieldName: "",
    yFieldName: "",

    constructor: function (options) {
      lang.mixin(this, options);

      this.useAddr = true;
      //used for new layers that will be constructed...suppose I could just pull the value from the edit layer and not store both...
      this.objectIdField = "ObjectID";
      this.nls = options.nls;

      //TODO this is now configurable...need to pull from there
      this.minScore = 90;

      //TODO sneed to remove this and associated processing based on it
      this.geocodeManager = new GeocodeCacheManager({
        appConfig: options.appConfig,
        nls: options.nls
      });
    },

    handleCsv: function () {
      var def = new Deferred();
      if (this.file && !this.file.data) {
        var reader = new FileReader();
        reader.onload = lang.hitch(this, function () {
          this.data = reader.result;
          this._processCsvData().then(function (fieldsInfo) {
            def.resolve(fieldsInfo)
          });
        });
        reader.readAsText(this.file);
      }
      return def;
    },

    _processCsvData: function () {
      var def = new Deferred();
      this._convertSources();
      this._getSeparator();
      this._getCsvStore().then(function (fieldsInfo) {
        def.resolve(fieldsInfo)
      });
      return def;
    },

    processForm: function () {
      var def = new Deferred();
      this._locateData(this.useAddr).then(lang.hitch(this, function (data) {
        var results = {};
        var matchedFeatures = [];
        var unmatchedFeatures = [];
        var duplicateFeatures = [];
        var duplicateLookupList = {};
        var unmatchedI = 0;
        var duplicateI = 0;
        var keys = Object.keys(data);
        for (var i = 0; i < keys.length; i++) {
          var attributes = {};
          var di = data[keys[i]];
          var si = this.storeItems[di.csvIndex];
          array.forEach(this.fsFields, lang.hitch(this, function (f) {
            attributes[f.name] = this.csvStore.getValue(si, this.mappedArrayFields[f.name]);
          }));

          if (di && di.score > this.minScore) {
            attributes["ObjectID"] = i - unmatchedI - duplicateI;
            matchedFeatures.push({
              "geometry": di.location,
              "attributes": lang.clone(attributes)
            });
          } else if (di.isDuplicate) {
            attributes["ObjectID"] = duplicateI;
            //leave this for now...it is not necessary for this to function but could be helpful in testing
            //attributes["DestinationOID"] = di.featureAttributes[this.editLayer.objectIdField],
            duplicateFeatures.push({
              "geometry": di.location,
              "attributes": lang.clone(attributes)
            });
            duplicateLookupList[duplicateI] = di.featureAttributes;
            duplicateI++;
          } else {
            attributes["ObjectID"] = unmatchedI;
            //need to handle the null location by doing something
            // not actually sure if this is the best way...may not store the geom...
            unmatchedFeatures.push({
              "geometry": new Point(0, 0, this.map.spatialReference),
              "attributes": lang.clone(attributes)
            });
            unmatchedI++;
          }
        }

        var use;
        if (matchedFeatures.length > 0) {
          this.matchedFeatureLayer = this._initLayer(matchedFeatures, this.file.name);
          use = "matched"
          //feature list should support zoom to its children
          this._zoomToData(this.matchedFeatureLayer);
        }

        if (duplicateFeatures.length > 0) {
          this.duplicateFeatureLayer = this._initLayer(duplicateFeatures, this.file.name + "_Duplicate");
        }

        if (unmatchedFeatures.length > 0) {
          this.unMatchedFeatureLayer = this._initLayer(unmatchedFeatures, this.file.name += "_UnMatched");
        }

        def.resolve({
          matchedLayer: this.matchedFeatureLayer,
          unMatchedLayer: this.unMatchedFeatureLayer,
          duplicateLayer: this.duplicateFeatureLayer,
          duplicateLookupList: duplicateLookupList
        });

      }));
      return def;
    },

    _initLayer: function (features, id) {
      var fc = this._generateFC(features);
      var lyr = new FeatureLayer(fc, {
        id: id,
        editable: true,
        outFields: ["*"]
      });
      this.map.addLayers([lyr]);
      return lyr;
    },

    _findDuplicates: function () {
      var def = new Deferred();
      this._getAllLayerFeatures(this.editLayer, this.fsFields).then(lang.hitch(this, function (layerFeatures) {
        this.keys = Object.keys(this.mappedArrayFields);
        this.oidField = this.editLayer.objectIdField;
        //TODO remove this when we allow the user to choose fields from the config...otherwise it will be forced to compare on all fields with no way to disable
        if (this.duplicateTestFields.length === 0) {
          this.duplicateTestFields = this.keys;
        }

        //recursive function for testing for duplicate attribute values
        var _testFieldValues = lang.hitch(this, function (testFeatures, index) {
          var def = new Deferred();
          var matchValues = [];
          var layerFieldName = this.keys[index];
          if (layerFieldName === this.oidField || this.duplicateTestFields.indexOf(layerFieldName) === -1) {
            def.resolve(testFeatures);
          } else {
            var fileFieldName = this.mappedArrayFields[layerFieldName];
            for (var ii = 0; ii < this.storeItems.length; ii++) {
              var item = this.storeItems[ii];
              var fileValue = this.csvStore.getValue(item, fileFieldName);
              var fileId = item._csvId;
              array.forEach(testFeatures, function (feature) {
                //first time trough features will be from layer query...additional times through they will
                // be from our result object
                var _feature = feature.attributes ? feature : feature.feature;
                var featureValue = _feature.attributes[layerFieldName];
                if (fileValue === featureValue) {
                  matchValues.push({
                    feature: _feature,
                    featureId: _feature.attributes[this.oidField],
                    fileId: fileId
                  });
                }
              });
            }

            if (matchValues.length > 0) {
              index += 1;
              _testFieldValues(matchValues, index).then(lang.hitch(this, function (results) {
                def.resolve(results);
              }));
            } else {
              def.resolve(matchValues);
              return def.promise;
            }
          }

          return def;
        });

        //make the inital call to test fields
        _testFieldValues(layerFeatures, 0).then(lang.hitch(this, function (results) {
          //pass the results so the locate function will know what ones to skip
          def.resolve(results);
        }));
      }));

      return def;
    },

    _getAllLayerFeatures: function (lyr, fields) {
      var def = new Deferred();

      var max = lyr.maxRecordCount;

      var q = new Query();
      q.where = "1=1";
      lyr.queryIds(q).then(function (ids) {
        var queries = [];
        var i, j;
        if (ids.length > 0) {
          for (i = 0, j = ids.length; i < j; i += max) {
            var q = new Query();
            q.outFields = fields;
            q.objectIds = ids.slice(i, i + max);
            q.returnGeometry = true;

            queries.push(lyr.queryFeatures(q));
          }
          var queryList = new DeferredList(queries);
          queryList.then(lang.hitch(this, function (queryResults) {
            if (queryResults) {
              var allFeatures = [];
              for (var i = 0; i < queryResults.length; i++) {
                if (queryResults[i][1].features) {
                  //allFeatures.push.apply(allFeatures, queryResults[i][1].features);
                  //may not do this if it takes a performance hit...just seems like less to keep in memory
                  allFeatures.push.apply(allFeatures, queryResults[i][1].features.map(function (f) {
                    return {
                      geometry: f.geometry,
                      attributes: f.attributes
                    }
                  }));
                }
              }
              def.resolve(allFeatures);
            }
          }));
        } else {
          def.resolve([]);
        }
      });
      return def;
    },

    //TODO this is the main function that needs attention right now
    _locateData: function (useAddress) {
      var def = new Deferred();
      if (useAddress) {
        this.geocodeManager.getCache().then(lang.hitch(this, function (cacheData) {
          this._findDuplicates().then(lang.hitch(this, function (duplicateData) {
            this.duplicateData = duplicateData;
            //recursive function that will process un-matched records when more than one locator has been provided
            var _geocodeData = lang.hitch(this, function (cacheData, storeItems, _idx, finalResults) {
              cacheData = {}; //TODO prevent cache logic for now
              var def = new Deferred();
              var locatorSource = this._geocodeSources[_idx];
              var locator = locatorSource.locator;
              locator.outSpatialReference = this.spatialReference;
              var unMatchedStoreItems = [];
              var geocodeOps = [];
              var oid = "OBJECTID";
              var max = 500;
              var x = 0;
              var i, j;
              //loop through all provided store items
              store_item_loop:
              for (var i = 0, j = storeItems.length; i < j; i += max) {
                var items = storeItems.slice(i, i + max);
                var addresses = [];
                if (locatorSource.singleEnabled || locatorSource.multiEnabled) {
                  array.forEach(items, lang.hitch(this, function (item) {
                    var csvID = item._csvId;
                    //test if ID is in duplicate data
                    var duplicateItem = null;
                    duplicate_data_loop:
                    for (var duplicateKey in this.duplicateData) {
                      var duplicateDataItem = this.duplicateData[duplicateKey];
                      if (duplicateDataItem.fileId === csvID) {
                        //look and see if I cab actually just pass the geom here or if I need to muck with it
                        duplicateItem = Object.assign({}, duplicateDataItem);
                        delete this.duplicateData[duplicateKey];
                        break duplicate_data_loop
                      }
                    }

                    var addr = {};
                    addr[oid] = csvID;
                    if (this.useMultiFields && locatorSource.multiEnabled) {
                      array.forEach(this.multiFields, lang.hitch(this, function (f) {
                        if (f.value !== this.nls.noValue) {
                          var val = this.csvStore.getValue(item, f.value);
                          addr[f.keyField] = val;
                        }
                      }));
                    } else if (locatorSource.singleEnabled) {
                      if (this.singleFields[0].value !== this.nls.noValue) {
                        var s_val = this.csvStore.getValue(item, this.singleFields[0].value);
                        if (typeof (s_val) === 'undefined') {
                          //otherwise multiple undefined values are seen as the same key
                          // may need to think through other potential duplicates
                          s_val = typeof (s_val) + csvID;
                        }
                        addr[locatorSource.singleLineFieldName] = s_val;
                      }
                    }

                    //most of this is to support the cahce concept that I'm not sure if it will stick around
                    var clone = Object.assign({}, addr);
                    delete clone[oid]
                    var cacheKey = JSON.stringify(clone);
                    var _cacheData = cacheData ? cacheData : {};
                    if ((!(_cacheData && _cacheData.hasOwnProperty(cacheKey) ? true : false)) && duplicateItem === null) {
                      addresses.push(addr);
                      finalResults[cacheKey] = {
                        index: x,
                        csvIndex: csvID,
                        location: {}
                      };
                      x += 1
                    } else {
                      if (duplicateItem !== null) {
                        finalResults[cacheKey] = {
                          index: -1,
                          csvIndex: csvID,
                          isDuplicate: true,
                          location: Object.assign({}, duplicateItem.feature.geometry),
                          featureAttributes: duplicateItem.feature.attributes
                        };
                      } else {
                        finalResults[cacheKey] = {
                          index: -1,
                          csvIndex: csvID,
                          location: _cacheData[cacheKey].location
                        };
                      }
                    }
                  }));
                }
                geocodeOps.push(locator.addressesToLocations({
                  addresses: addresses,
                  countryCode: locatorSource.countryCode,
                  outFields: ["ResultID", "Score"]
                }));
              }
              var keys = Object.keys(finalResults);
              var geocodeList = new DeferredList(geocodeOps);
              geocodeList.then(lang.hitch(this, function (results) {
                _idx += 1;
                //var storeItems = this.storeItems;
                var additionalLocators = this._geocodeSources.length > _idx;
                if (results) {
                  var minScore = this.minScore;
                  var idx = 0;
                  array.forEach(results, function (r) {
                    var defResults = r[1];
                    array.forEach(defResults, function (result) {
                      result.ResultID = result.attributes.ResultID;
                    });
                    var geocodeDataStore = Observable(new Memory({
                      data: defResults,
                      idProperty: "ResultID"
                    }));
                    var resultsSort = geocodeDataStore.query({}, { sort: [{ attribute: "ResultID" }] });
                    array.forEach(resultsSort, function (_r) {
                      for (var k in keys) {
                        var _i = keys[k];
                        if (finalResults[_i] && finalResults[_i].index === idx) {
                          if (_r.attributes["Score"] < minScore) {
                            if (additionalLocators) {
                              //unMatchedStoreItems.push(storeItems[finalResults[_i].csvIndex]);
                              delete finalResults[_i];
                            }
                          } else {
                            finalResults[_i].location = _r.location;
                            finalResults[_i].score = _r.attributes["Score"];
                            delete finalResults[_i].index
                          }
                          delete keys[k];
                          break;
                        }
                      }
                      idx += 1;
                    });
                  });
                  if (additionalLocators && unMatchedStoreItems.length > 0) {
                    _geocodeData(finalResults, unMatchedStoreItems, _idx, finalResults).then(lang.hitch(this, function (data) {
                      def.resolve(data);
                    }));
                  } else {
                    def.resolve(finalResults);
                    return def.promise;
                  }
                }
              }));
              return def;
            });

            //make the inital call to this recursive function
            _geocodeData(cacheData, this.storeItems, 0, {}).then(lang.hitch(this, function (results) {
              def.resolve(results);
            }));
          }));
        }));
      } else {
        this._xyData({
          storeItems: this.storeItems,
          csvStore: this.csvStore,
          xFieldName: this.xFieldName,
          yFieldName: this.yFieldName,
          wkid: this.map.spatialReference.wkid,
          duplicateData: duplicateData
        }).then(function (data) {
          def.resolve(data);
        });
      }
      return def;
    },

    _xyData: function (options) {
      //TODO eventually it would be good to use the defense solutions parsing logic...we could suppport many types of coordinates
      var def = new Deferred();
      var isGeographic = undefined;
      var data = [];
      var csvStore = options.csvStore;
      var duplicateData = options.duplicateData;
      array.forEach(options.storeItems, function (i) {
        var attributes = {};
        var _attrs = csvStore.getAttributes(i);
        array.forEach(_attrs, function (a) {
          attributes[a] = csvStore.getValue(i, a);
        });
        var x = parseFloat(csvStore.getValue(i, options.xFieldName));
        var y = parseFloat(csvStore.getValue(i, options.yFieldName));
        if (typeof (isGeographic) === 'undefined') {
          isGeographic = /(?=^[-]?\d{1,3}\.)^[-]?\d{1,3}\.\d+|(?=^[-]?\d{4,})|^[-]?\d{1,3}/.exec(x) ? true : false;
        }

        //TODO may want to consider some other tests here to make sure we avoid
        // potential funky/bad corrds from passing through
        if (x !== NaN && y !== NaN) {
          var geometry = new Point(x, y);
          if (isGeographic) {
            geometry = webMercatorUtils.geographicToWebMercator(geometry);
          } else {
            geometry.spatialReference = new SpatialReference({ wkid: options.wkid });
          }
          data.push({
            attributes: attributes,
            location: geometry,
            csvIndex: i._csvId,
            score: 100
          })
        }
      });
      def.resolve(data);
      return def;
    },

    _generateFC: function (features) {
      var baseImageUrl = window.location.protocol + "//" + window.location.host + require.toUrl("widgets");
      //create a feature collection for the input csv file
      var lyr = {
        "layerDefinition": {
          "geometryType": "esriGeometryPoint",
          "objectIdField": this.objectIdField,
          "type": "Feature Layer",
          "drawingInfo": {
            "renderer": {
              "type": "simple",
              "symbol": {
                "type": "esriPMS",
                "url": baseImageUrl + "/CriticalFacilities/images/redpushpin.png",
                "contentType": "image/png",
                "width": 15,
                "height": 15
              }
            }
          },
          "fields": [
              {
                "name": this.objectIdField,
                "alias": this.objectIdField,
                "type": "esriFieldTypeOID"
              }
          ]
        },
        "featureSet": {
          "features": features,
          "geometryType": "esriGeometryPoint"
        }
      };

      array.forEach(this.fsFields, lang.hitch(this, function (af) {
        lyr.layerDefinition.fields.push({
          "name": af.name,
          "alias": af.label,
          "type": af.value,
          "editable": true,
          "domain": null
        });
      }));

      return lyr;
    },

    clear: function () {
      this._removeLayer(this.matchedFeatureLayer);
      this._removeLayer(this.unMatchedFeatureLayer);
      this._removeLayer(this.duplicateFeatureLayer);

      this.file = undefined;
      this.fsFields = undefined;
      this.data = undefined;
      this.separatorCharacter = undefined;
      this.csvStore = undefined;
      this.storeItems = undefined;
      this.duplicateData = [];
      this.matchedFeatureLayer = undefined;
      this.unMatchedFeatureLayer = undefined;
      this.duplicateFeatureLayer = undefined;
      this.mappedArrayFields = undefined;
      this.useAddr = true;
      this.addrFieldName = "";
      this.xFieldName = "";
      this.yFieldName = "";
    },

    _removeLayer: function (layer) {
      if (layer) {
        this.map.removeLayer(layer);
        layer.clear();
      }
    },

    _getSeparator: function () {
      var newLineIndex = this.data.indexOf("\n");
      var firstLine = lang.trim(this.data.substr(0, newLineIndex));
      var separators = [",", "      ", ";", "|"];
      var maxSeparatorLength = 0;
      var maxSeparatorValue = "";
      array.forEach(separators, function (separator) {
        var length = firstLine.split(separator).length;
        if (length > maxSeparatorLength) {
          maxSeparatorLength = length;
          maxSeparatorValue = separator;
        }
      });
      this.separatorCharacter = maxSeparatorValue;
    },

    _getCsvStore: function () {
      var def = new Deferred();
      this.csvStore = new CsvStore({
        data: this.data,
        separator: this.separatorCharacter
      });
      this.csvStore.fetch({
        onComplete: lang.hitch(this, function (items) {
          this.storeItems = items;
          this._fetchFieldsAndUpdateForm(this.storeItems, this.csvStore, this.fsFields).then(function (fieldsInfo) {
            def.resolve(fieldsInfo)
          });
        }),
        onError: function (error) {
          console.error("Error fetching items from CSV store: ", error);
          def.reject(error);
        }
      });
      return def;
    },

    //check the values in the fields to evaluate if they are potential candidates for an integer of float field
    // allows us to filter the list of fields exposed for those field types from the destination layer
    _fetchFieldsAndUpdateForm: function (storeItems, csvStore, fsFields) {
      var def = new Deferred();
      var csvFieldNames = csvStore._attributes;
      var fieldTypes = {};
      var len = function (v) {
        return v.toString().length;
      };
      array.forEach(csvFieldNames, function (attr) {
        var type = null;
        array.forEach(storeItems, function (si) {
          var checkVal = true;
          var fTypeInt = true;
          var fTypeFloat = true;
          if (fieldTypes.hasOwnProperty(attr)) {
            fTypeInt = fieldTypes[attr].supportsInt;
            fTypeFloat = fieldTypes[attr].supportsFloat;
            if (!(fTypeInt) && !(fTypeFloat)) {
              checkVal = false;
            }
          }
          if (checkVal) {
            var v = csvStore.getValue(si, attr);
            if (v) {
              fieldTypes[attr] = {
                supportsInt: ((parseInt(v) !== NaN) && len(parseInt(v)) === len(v)) && fTypeInt,
                supportsFloat: ((parseFloat(v) !== NaN) && len(parseFloat(v)) === len(v)) && fTypeFloat
              }
            }
          }
        });
      });
      def.resolve({
        fields: csvFieldNames,
        fieldTypes: fieldTypes,
        fsFields: fsFields
      });
      return def;
    },

    _zoomToData: function (featureLayer) {
      if (featureLayer.graphics && featureLayer.graphics.length > 0) {
        try {
          //TODO this would not handle null features
          var ext = graphicsUtils.graphicsExtent(featureLayer.graphics);
          this.map.setExtent(ext.expand(1.5), true)
        } catch (err) {
          console.log(err.message);
        }
      }
    },

    _convertSources: function () {
      if (this.geocodeSources && this.geocodeSources.length > 0) {
        this._geocodeSources = array.map(this.geocodeSources, lang.hitch(this, function (source) {
          if (source && source.url && source.type === 'locator') {
            var _source = {
              locator: new Locator(source.url || ""),
              outFields: ["ResultID", "Score"],
              singleLineFieldName: source.singleLineFieldName || "",
              name: jimuUtils.stripHTML(source.name || ""),
              placeholder: jimuUtils.stripHTML(source.placeholder || ""),
              countryCode: source.countryCode || "",
              addressFields: source.addressFields,
              singleEnabled: source.singleEnabled || false,
              multiEnabled: source.multiEnabled || false
            };
            return _source;
          }
        }));
      }
    }
  });
});