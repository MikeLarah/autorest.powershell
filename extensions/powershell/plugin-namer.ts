/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Host, Channel } from '@microsoft.azure/autorest-extension-base';
import { codemodel, processCodeModel, allVirtualParameters, allVirtualProperties, resolveParameterNames, resolvePropertyNames, ModelState } from '@microsoft.azure/autorest.codemodel-v3';
import { deconstruct, values, removeProhibitedPrefix, removeSequentialDuplicates, pascalCase } from '@microsoft.azure/codegen';
import * as linq from '@microsoft.azure/linq';
import { singularize } from './name-inferrer';
type State = ModelState<codemodel.Model>;

export async function namer(service: Host) {
  return processCodeModel(tweakModel, service);
}

export function getDeduplicatedSubjectPrefix(subjectPrefix: string, subject: string): string {
  // It removes intersection with the subject from the subjectPrefix:
  //    ContainerServiceContainerService -> ContainerService, 
  //    AppConfigurationConfigurationService -> AppConfiguration
  const p = [...removeSequentialDuplicates(deconstruct(subjectPrefix))];
  const s = [...removeSequentialDuplicates(deconstruct(subject))];
  const both = [...removeSequentialDuplicates([...p, ...s])];
  return pascalCase(both.slice(0, -s.length));
}

async function tweakModel(state: State): Promise<codemodel.Model> {
  // get the value 
  const isAzure = await state.getValue('azure', false);
  const shouldSanitize = await state.getValue('sanitize-names', false);

  // make sure recursively that every details field has csharp
  for (const { index, instance } of linq.visitor(state.model)) {
    if (index === 'details' && instance.default && !instance.csharp) {
      instance.csharp = linq.clone(instance.default, false, undefined, undefined, ['schema', 'origin']);
    }
  }

  if (shouldSanitize || isAzure) {
    for (const operation of values(state.model.commands.operations)) {
      // clean the noun (i.e. subjectPrefix + subject)
      const prevSubjectPrefix = operation.details.csharp.subjectPrefix;
      const newSubjectPrefix = getDeduplicatedSubjectPrefix(operation.details.csharp.subjectPrefix, operation.details.csharp.subject);
      if (prevSubjectPrefix !== newSubjectPrefix) {
        const verb = operation.details.csharp.verb;
        const subject = operation.details.csharp.subject;
        const variantName = operation.details.csharp.name;
        const prevCmdletName = getCmdletName(verb, prevSubjectPrefix, subject);
        operation.details.csharp.subjectPrefix = newSubjectPrefix;
        const newCmdletName = getCmdletName(verb, operation.details.csharp.subjectPrefix, subject);
        state.message(
          {
            Channel: Channel.Verbose,
            Text: `Sanitized cmdlet-name -> Changed cmdlet-name from ${prevCmdletName} to ${newCmdletName}: {subjectPrefix: ${newSubjectPrefix}, subject: ${subject}${variantName ? `, variant: ${variantName}}` : '}'}`
          }
        );
      }

      const virtualParameters = [...allVirtualParameters(operation.details.csharp.virtualParameters)]
      for (const parameter of virtualParameters) {
        let prevName = parameter.name;
        const otherParametersNames = values(virtualParameters)
          .linq.select(each => each.name)
          .linq.where(name => name !== parameter.name)
          .linq.toArray();

        // first try to singularize the parameter
        const singularName = singularize(parameter.name);
        if (prevName != singularName) {
          parameter.name = singularName;
          state.message({ Channel: Channel.Verbose, Text: `Sanitized parameter-name -> Changed parameter-name from ${prevName} to singular ${parameter.name} from command ${operation.verb}-${operation.details.csharp.subjectPrefix}${operation.details.csharp.subject}` });
        }

        // save the name again to compare in case it was modified
        prevName = parameter.name;

        // now remove the subject from the beginning of the parameter
        // to reduce naming redundancy
        // e.g. get-vm -vmname ---> get-vm -name
        const sanitizedName = removeProhibitedPrefix(
          parameter.name,
          operation.details.csharp.subject,
          otherParametersNames
        );

        if (prevName !== sanitizedName) {
          if (parameter.alias === undefined) {
            parameter.alias = [];
          }

          // saved the prev name as alias
          parameter.alias.push(parameter.name);

          // change name
          parameter.name = sanitizedName;
          state.message({ Channel: Channel.Verbose, Text: `Sanitized parameter-name -> Changed parameter-name from ${prevName} to ${parameter.name} from command ${operation.verb}-${operation.details.csharp.subjectPrefix}${operation.details.csharp.subject}` });
          state.message({ Channel: Channel.Verbose, Text: `                         -> And, added alias '${prevName}'` });
        }
      }
    }

    for (const schema of values(state.model.schemas)) {
      const virtualProperties = [...allVirtualProperties(schema.details.csharp.virtualProperties)];

      for (const property of virtualProperties) {
        let prevName = property.name;
        const otherPropertiesNames = values(virtualProperties)
          .linq.select(each => each.name)
          .linq.where(name => name !== property.name)
          .linq.toArray();

        // first try to singularize the property
        const singularName = singularize(property.name);
        if (prevName != singularName) {
          property.name = singularName;
          state.message({ Channel: Channel.Verbose, Text: `Sanitized property-name -> Changed property-name from ${prevName} to singular ${property.name} from model ${schema.details.csharp.name}` });
        }

        // save the name again to compare in case it was modified
        prevName = property.name;

        // now remove the model=name from the beginning of the property-name
        // to reduce naming redundancy
        const sanitizedName = removeProhibitedPrefix(
          property.name,
          schema.details.csharp.name,
          otherPropertiesNames
        );

        if (prevName !== sanitizedName) {
          if (property.alias === undefined) {
            property.alias = [];
          }

          // saved the prev name as alias
          property.alias.push(property.name);

          // change name
          property.name = sanitizedName;
          state.message({ Channel: Channel.Verbose, Text: `Sanitized property-name -> Changed property-name from ${prevName} to ${property.name} from model ${schema.details.csharp.name}` });
          state.message({ Channel: Channel.Verbose, Text: `                        -> And, added alias '${prevName}'` });
        }
      }
    }
  }

  // do collision detection work.
  for (const command of values(state.model.commands.operations)) {
    const vp = command.details.csharp.virtualParameters;
    if (vp) {
      resolveParameterNames([], vp);
    }
  }

  for (const schema of values(state.model.schemas)) {
    const vp = schema.details.csharp.virtualProperties;
    if (vp) {
      resolvePropertyNames([schema.details.csharp.name], vp);
    }
  }
  return state.model;
}


function getCmdletName(verb: string, subjectPrefix: string, subject: string): string {
  return `${verb}-${subjectPrefix}${subject}`;
}