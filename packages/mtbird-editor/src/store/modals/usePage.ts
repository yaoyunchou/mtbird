import { IComponentInstance, IEditorOptions, IPosition } from '@mtbird/shared';
import { COMPONENT_NAME, generateKeys, getWrapperPosition, dataURItoBlob } from '@mtbird/core';
import { useState, useEffect, useRef } from 'react';
import { computeBlockOverstep, flattenComponentTree, getComponentArray, needOverstep } from '../../utils';
import { message } from 'antd';
import IContext from '../types/page';
import * as Components from '@mtbird/component-basic';
import { toPng } from 'html-to-image';
import isEqual from 'lodash/isEqual';
import cloneDeep from 'lodash/cloneDeep';
import isArray from 'lodash/isArray';
import set from 'lodash/set';
import get from 'lodash/get';
import keys from 'lodash/keys';
import findIndex from 'lodash/findIndex';
import { SchemaDataSource } from '@mtbird/helper-component';
import Moveable from 'react-moveable';

const ADD_ROOT_COMPONENT = [COMPONENT_NAME.CONTAINER_BLOCK, COMPONENT_NAME.MODAL];

function usePageModal(options: IEditorOptions): IContext {
  const { pageConfig, onSave, pageList } = options;
  const [tmpPageConfig, setTmpPageConfig] = useState(cloneDeep(pageConfig));
  const [currentComponent, setCurrentComponent] = useState<IComponentInstance[]>([tmpPageConfig.data as IComponentInstance]);
  const [pageData, setPageData] = useState({});
  const [hasEdit, setHasEdit] = useState(false);
  const [componentMap, setComponentMap] = useState(new Map<string, IComponentInstance>());
  const moveableRef = useRef<Moveable | undefined>();

  // do this for refresh currentComponent when tmpPageConfig changed
  useEffect(() => {
    setCurrentComponent(currentComponent);
    setComponentMap(flattenComponentTree(tmpPageConfig.data));
  }, [tmpPageConfig]);

  useEffect(() => {
    refreshDataSource();
  }, [currentComponent]);

  const getMoveable = () => {
    return moveableRef.current;
  };

  const onSchemaChange = (keyPath: string, value: any, componentId?: string) => {
    // if not componentId, change current
    if (!componentId) {
      getComponentArray(currentComponent).forEach((cur: IComponentInstance) => {
        set(cur, keyPath, value);
      });
    } else {
      const component = componentMap.get(componentId);
      set(component, keyPath, value);
    }

    let finalPage = { ...tmpPageConfig };

    // only change attribute `top` and `height` in style, recalculation overstep
    if (needOverstep(keyPath, value)) {
      finalPage.data = computeBlockOverstep(finalPage.data);
    }
    setTmpPageConfig(finalPage);
    setHasEdit(true);

    setTimeout(() => {
      getMoveable()?.updateTarget();
    });
  };

  const onPageDataChange = (keyPath: string, value: any) => {
    set(pageData, value);
    setPageData(pageData);
  };

  const [schemaDataSource, setSchemaDataSource] = useState(new SchemaDataSource({ currentComponent, componentMap }, onSchemaChange));
  const [pageDataSource, setPageDataSource] = useState(new SchemaDataSource(pageData, onPageDataChange));

  const refreshDataSource = () => {
    setSchemaDataSource(new SchemaDataSource({ currentComponent, componentMap }, onSchemaChange));
  };

  const onSelect = (component: IComponentInstance | Array<IComponentInstance>) => {
    const cpt = getComponentArray(component);
    // Cancel select, select root
    if (cpt.length === 0) {
      return setCurrentComponent([tmpPageConfig.data] as any);
    }

    const targetIds = cpt.map((cur: IComponentInstance) => cur.id).sort();
    const curIds = getComponentArray(currentComponent)
      .map((cur: IComponentInstance) => cur.id)
      .sort();

    // throttle
    if (isEqual(targetIds, curIds)) return;

    // set related component object as currentComponent
    // @ts-ignore
    setCurrentComponent(targetIds.map((cur: string) => componentMap.get(cur)));
  };

  const addComponent = (component: IComponentInstance, parentComponentId?: string) => {
    const current = currentComponent ? currentComponent[0] : tmpPageConfig.data;
    let parent;
    let isCurrentBeParent = false;

    if (parentComponentId) {
      parent = componentMap.get(parentComponentId);
      // if Modal or ContainerBlock, parent should be root only
    } else if (ADD_ROOT_COMPONENT.indexOf(component.componentName) !== -1) {
      parent = tmpPageConfig.data;
    } else {
      if (current.componentName === COMPONENT_NAME.CONTAINER_ROOT) {
        parent = current.children[0];
      } else if (current.type === 'container' || current.componentName === COMPONENT_NAME.FORM) {
        parent = current;
        isCurrentBeParent = true;
      } else {
        parent = componentMap.get(current.parent);
      }
    }

    const newComponent = cloneDeep(component);

    newComponent.id = generateKeys();
    newComponent.parent = parent.id;

    if (Components[newComponent.componentName]?.initManifest) {
      Components[newComponent.componentName]?.initManifest(newComponent);
    }

    // if newComponent has children
    if (newComponent.children && isArray(newComponent.children)) {
      newComponent.children.forEach((cur: IComponentInstance | string) => {
        if (typeof cur === 'string') return;

        cur.id = generateKeys();
        cur.parent = newComponent.id;
      });
    }

    // if parent not find, use root's first children
    if (!parent) {
      parent = tmpPageConfig.data.children[0];
    }

    if (parent.children) {
      if (isArray(parent.children)) {
        // if current select only 1 then insert into next of currentComponent inside parent's children array
        // and if current is the parent, insert into last
        if (currentComponent.length === 1 && !isCurrentBeParent) {
          const index = findIndex(parent.children, (cur: IComponentInstance) => cur.id === current.id);
          parent.children.splice(index + 1, 0, newComponent);
        } else {
          parent.children.push(newComponent);
        }
      } else {
        parent.children = [parent.children, newComponent];
      }
    } else {
      parent.children = [newComponent];
    }

    setTmpPageConfig({ ...tmpPageConfig });
    setHasEdit(true);
    // default select new component
    setCurrentComponent([newComponent]);
  };

  const context: IContext = {
    state: {
      componentMap,
      pageDataSource,
      schemaDataSource,
      pageConfig: tmpPageConfig,
      pageList: pageList ? pageList : [pageConfig],
      currentComponent,
      moveableRef
    },
    actions: {
      getMoveable,
      setCurrentComponent,
      onSave: async () => {
        const dom: any = document.getElementById(tmpPageConfig.data.id)?.parentNode;

        let dataUrl = undefined;
        let avatarUrl = undefined;
        if (dom) {
          // for compress, jpeg only
          dataUrl = await toPng(dom, { quality: 0.8 });
          avatarUrl = await options.onUpload([dataURItoBlob(dataUrl)]);
          avatarUrl = avatarUrl[0];
        }
        onSave && onSave(tmpPageConfig.data, avatarUrl as string);
        setHasEdit(false);
      },
      onChange: onSchemaChange,
      onBatchChange: (record: Map<string, Record<string, any>>) => {
        let checkOverstep = false;
        record.forEach((value, key) => {
          keys(value).map((cur: string) => {
            checkOverstep = needOverstep(cur, value[cur]);
            set(componentMap.get(key), cur, value[cur]);
          });
        });

        let finalPage = { ...tmpPageConfig };

        if (checkOverstep) {
          finalPage.data = computeBlockOverstep(finalPage.data);
        }
        setTmpPageConfig(finalPage);
      },
      onSelect,
      onSelectContinue: (component: IComponentInstance | Array<IComponentInstance>) => {
        const targets = getComponentArray(component);
        const currents = getComponentArray(currentComponent);

        if (!currentComponent || currentComponent.length < 1) return onSelect(targets);

        const currentIds = currents.map((cur: IComponentInstance) => cur.id);
        const targetIds = targets.map((cur: IComponentInstance) => cur.id);

        const dbSelectedIds = currentIds.filter((cur: string | undefined) => {
          return targetIds.indexOf(cur) !== -1;
        });
        const finalArray = targets.concat(currents);
        const commonParent = finalArray[0].parent;

        onSelect(finalArray.filter((cur: IComponentInstance) => dbSelectedIds.indexOf(cur.id) === -1 && cur.parent === commonParent));
      },
      group: (components: IComponentInstance[]) => {
        if (!components || components.length < 2) return;

        const commonParent: string | undefined = components[0].parent;
        const groupableComponents = components.filter((cur) => cur.parent === commonParent);
        const groupableComponentIds = groupableComponents.map((cur) => cur.id);
        const pos = getWrapperPosition(groupableComponents);

        const container: IComponentInstance = Components.utils.generateContainer(
          groupableComponents.map((cur) => {
            const { style } = cur.props;
            style.left = style.left - pos.left;
            style.top = style.top - pos.top;
            return cur;
          }),
          pos
        ) as IComponentInstance;
        const parent: IComponentInstance = componentMap.get(commonParent as string) as IComponentInstance; // findComponentByKey(tmpPageConfig.data, commonParent);

        parent.children = (parent.children as IComponentInstance[]).filter((cur: IComponentInstance) => {
          return groupableComponentIds.indexOf(cur.id) === -1;
        });
        container.parent = commonParent;
        container.id = generateKeys();

        parent.children.push(container);
        setTmpPageConfig(tmpPageConfig);
        setCurrentComponent([container]);
      },
      ungroup: (component: IComponentInstance) => {
        if (!component) return;
        const children = component.children as IComponentInstance[];
        const parent = componentMap.get(component.parent as string) as IComponentInstance;
        const moveableChildren = children.map((cur: IComponentInstance) => {
          const { style } = cur.props;
          style.left = style.left + component.props?.style?.left;
          style.top = style.top + component.props?.style?.top;
          return { ...cur };
        });

        parent.children = (parent.children as IComponentInstance[])
          .concat(moveableChildren)
          .filter((cur: IComponentInstance) => cur.id !== component.id);
        setTmpPageConfig(tmpPageConfig);
        setCurrentComponent([parent]);
      },
      addComponentWithPos: (pos: IPosition, component: IComponentInstance, parentComponentId?: string) => {
        const cps = cloneDeep(component);

        set(cps, 'props.style', { ...get(cps, 'props.style'), ...pos });
        return addComponent(cps, parentComponentId);
      },
      addComponent,
      deleteComponent: () => {
        if (!currentComponent || currentComponent.length === 0) return;

        const toDelete = (component: IComponentInstance) => {
          // Root Container cannot be delete
          if (component.componentName === COMPONENT_NAME.CONTAINER_ROOT) return;
          const currentParent: IComponentInstance = componentMap.get(component.parent as string) as IComponentInstance;
          currentParent.children = currentParent.children.filter((cur: IComponentInstance) => cur.id !== component.id);
        };

        currentComponent.forEach(toDelete);
        setHasEdit(true);
        // cancel select
        setCurrentComponent([tmpPageConfig.data]);
      },
      publishPage: async () => {
        if (hasEdit) {
          return message.warning('当前页面未保存，请保存后再发布');
        }
        options.onPublish && options.onPublish();
      },
      goUpper: () => {
        if (!currentComponent) return;
        const parents = currentComponent.map((cur: IComponentInstance) => componentMap.get(cur.parent as string));

        parents.forEach((parent: IComponentInstance | undefined, i: number) => {
          if (!parent) return;
          const index = findIndex(parent.children, (cur: IComponentInstance) => cur.id === currentComponent[i].id);
          if (index >= (parent.children as IComponentInstance[]).length - 1) return;
          const tmp = parent.children[index + 1];
          parent.children[index + 1] = currentComponent[i];
          parent.children[index] = tmp;
        });
        setCurrentComponent([...currentComponent]);
      },
      goLower: () => {
        if (!currentComponent) return;
        const parents = currentComponent.map((cur: IComponentInstance) => componentMap.get(cur.parent as string));

        parents.forEach((parent: IComponentInstance | undefined, i: number) => {
          if (!parent) return;
          const index = findIndex(parent.children, (cur: IComponentInstance) => cur.id === currentComponent[i].id);
          if (index <= 0) return;
          const tmp = parent.children[index - 1];
          parent.children[index - 1] = currentComponent[i];
          parent.children[index] = tmp;
        });
        setCurrentComponent([...currentComponent]);
      },
      goTop: () => {
        if (!currentComponent) return;
        const parents = currentComponent.map((cur: IComponentInstance) => componentMap.get(cur.parent as string));

        parents.forEach((parent: IComponentInstance | undefined, i: number) => {
          if (!parent) return;
          const children = parent.children as IComponentInstance[];

          const index = findIndex(parent.children, (cur: IComponentInstance) => cur.id === currentComponent[i].id);
          if (index === children.length) return;
          const tmp = children[index];
          children.splice(index, 1);
          children.push(tmp);
        });
        setCurrentComponent([...currentComponent]);
      },
      goBottom: () => {
        if (!currentComponent) return;
        const parents = currentComponent.map((cur: IComponentInstance) => componentMap.get(cur.parent as string));

        parents.forEach((parent: IComponentInstance | undefined, i: number) => {
          if (!parent) return;
          const index = findIndex(parent.children, (cur: IComponentInstance) => cur.id === currentComponent[i].id);
          if (index <= 0) return;

          const children = parent.children as IComponentInstance[];
          const tmp = children[index];
          children.splice(index, 1);
          parent.children = [tmp, ...children];
        });
        setCurrentComponent([...currentComponent]);
      },
      copyComponent: () => {
        const newComponents = cloneDeep(currentComponent);
        newComponents.forEach((cur: IComponentInstance) => {
          cur.props.style.left = cur.props.style.left + 10;
          cur.props.style.top = cur.props.style.top + 10;
          context.actions.addComponent(cur, cur.parent);
        });
      },
      moveComponent: (leftOffset: number, topOffset: number) => {
        if (!currentComponent) return;
        const modify = (cur: IComponentInstance) => {
          set(cur, 'props.style.left', get(cur, 'props.style.left') + leftOffset);
          set(cur, 'props.style.top', get(cur, 'props.style.top') + topOffset);
        };

        currentComponent.map(modify);

        setTmpPageConfig({ ...tmpPageConfig });
        setHasEdit(true);
      }
    }
  };

  return context;
}

export default usePageModal;