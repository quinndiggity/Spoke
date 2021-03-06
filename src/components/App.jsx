import PropTypes from "prop-types";
import React from "react";
import theme from "../styles/theme";
import { StyleSheet, css } from "aphrodite";
import Form from "react-formal";
import GSTextField from "./forms/GSTextField";
import GSDateField from "./forms/GSDateField";
import GSScriptField from "./forms/GSScriptField";
import GSSelectField from "./forms/GSSelectField";
import GSPasswordField from "./forms/GSPasswordField";

Form.addInputTypes({
  string: GSTextField,
  description: GSTextField,
  number: GSTextField,
  date: GSDateField,
  email: GSTextField,
  script: GSScriptField,
  select: GSSelectField,
  password: GSPasswordField
});

const styles = StyleSheet.create({
  root: {
    ...theme.text.body,
    height: "100%"
  }
});

const App = ({ children }) => (
  <div className={css(styles.root)}>{children}</div>
);

App.propTypes = {
  children: PropTypes.object
};

export default App;
